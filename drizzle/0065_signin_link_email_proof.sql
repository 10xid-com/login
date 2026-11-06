-- Verified sign-in links, pilot fix (follows 0064; replaces start/complete/proof/consume bodies).
--
--  1. An address counts as VERIFIED for a link when EITHER the portal alias
--     (user_emails.verified_at) is verified OR the exact Better Auth address
--     (auth_users.email, case-folded) has email_verified = true on the identity
--     bound to that portal user (users.auth_user_id = auth_users.id). Migration
--     0047 cleared the alias flag for Rana, and already-bound identities set
--     email_verified without re-marking the alias, so the alias flag alone
--     excluded them. signin_link_email_owner() answers for ONE address: exactly
--     one live account may claim it (alias, users.email or bound identity,
--     verified or not); if two accounts claim it, or the single claimant is
--     unproven/service/unbound, there is no owner. Start and redeem both use it,
--     so the condition is identical at both points.
--  2. Redeem locks both users rows in canonical (id) order, holds them through the
--     link insert, and then re-reads fresh proof for both sides, the current
--     bindings, the challenge expiry and the recipient's ownership. These use
--     clock_timestamp(), not now(): now() is the transaction start and would be
--     stale after waiting on a lock.
-- Additive and replayable. No link is created and no tenant data is touched.
-- ROLLOUT: apply 0065 before the app that relies on it; it is safe with the
-- previous app. ROLLBACK: see docs/verified-signin-links.md.

-- Wall-clock proof. VOLATILE so it is re-evaluated after a lock wait.
CREATE OR REPLACE FUNCTION signin_link_proof(p_session text, p_fresh integer)
RETURNS TABLE(user_id uuid, auth_user_id text, fresh boolean)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.auth_user_id,
         s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at > clock_timestamp() - make_interval(secs => p_fresh)
    FROM auth_sessions s
    JOIN users u ON u.auth_user_id = s.user_id AND u.deleted_at IS NULL AND NOT u.is_service
   WHERE s.id = p_session AND s.expires_at > clock_timestamp() AND s.mfa_verified_at IS NOT NULL;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION signin_link_proof(text, integer) FROM PUBLIC, portal_app, portal_auth;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION signin_link_consume(p_session text, p_purpose text) RETURNS TABLE(user_id uuid, auth_user_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH a AS (
    DELETE FROM signin_link_attestations
     WHERE session_id = p_session AND purpose = p_purpose AND expires_at > clock_timestamp()
    RETURNING user_id, mfa_at
  )
  SELECT p.user_id, p.auth_user_id
    FROM a JOIN signin_link_proof(p_session, 300) p ON p.user_id = a.user_id AND p.fresh
    JOIN auth_sessions s ON s.id = p_session AND s.mfa_verified_at = a.mfa_at;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION signin_link_consume(text, text) FROM PUBLIC, portal_app, portal_auth;
--> statement-breakpoint

-- The single live, human, bound account that provably owns p_email, or no row.
CREATE OR REPLACE FUNCTION signin_link_email_owner(p_email text)
RETURNS TABLE(user_id uuid, auth_user_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH m AS (SELECT lower(btrim(coalesce(p_email, ''))) AS e),
  claim AS (
    SELECT u.id AS uid, u.auth_user_id AS aid, u.is_service AS svc, bool_or(c.proof) AS proven
      FROM (
        SELECT e.user_id AS uid, e.verified_at IS NOT NULL AS proof FROM user_emails e, m WHERE lower(e.email) = m.e
        UNION ALL
        SELECT x.id, false FROM users x, m WHERE lower(x.email) = m.e
        UNION ALL
        SELECT x.id, a.email_verified FROM auth_users a JOIN users x ON x.auth_user_id = a.id, m WHERE lower(a.email) = m.e
      ) c
      JOIN users u ON u.id = c.uid AND u.deleted_at IS NULL
     GROUP BY u.id, u.auth_user_id, u.is_service
  )
  SELECT uid, aid FROM claim
   WHERE proven AND NOT svc AND aid IS NOT NULL AND (SELECT count(*) FROM claim) = 1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION signin_link_email_owner(text) FROM PUBLIC, portal_app, portal_auth;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION signin_link_start(p_session text, p_code_hash text, p_primary_side text, p_recipient text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid; v_auth text; r_user uuid; r_auth text; v_mail text;
BEGIN
  v_mail := lower(btrim(coalesce(p_recipient, '')));
  IF p_primary_side NOT IN ('initiator', 'redeemer') OR p_code_hash !~ '^[0-9a-f]{64}$'
     OR length(v_mail) NOT BETWEEN 3 AND 320 THEN RETURN 'invalid'; END IF;
  SELECT c.user_id, c.auth_user_id INTO v_user, v_auth FROM signin_link_consume(p_session, 'start') c;
  IF v_user IS NULL THEN RETURN 'not_fresh'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('signin-link:' || v_user::text, 0));
  PERFORM signin_link_sweep(v_user);
  IF signin_link_unsettled(v_user, v_auth) THEN RETURN 'unsettled'; END IF;
  IF (SELECT count(*) FROM signin_links WHERE revoked_at IS NULL AND v_user IN (user_low, user_high)) >= 5 THEN
    RETURN 'limit';
  END IF;
  -- Exactly one owner of a verified address (alias or Better Auth), and not this account.
  SELECT o.user_id, o.auth_user_id INTO r_user, r_auth
    FROM signin_link_email_owner(v_mail) o
   WHERE o.user_id <> v_user AND o.auth_user_id <> v_auth;
  UPDATE signin_link_challenges SET closed_at = now(),
         outcome = CASE WHEN expires_at <= clock_timestamp() THEN 'expired' ELSE 'superseded' END
   WHERE initiator_user_id = v_user AND closed_at IS NULL;
  INSERT INTO signin_link_challenges(initiator_user_id, initiator_auth_user_id, initiator_session_id,
                                     code_hash, primary_side, expires_at,
                                     recipient_user_id, recipient_auth_user_id, recipient_email, initiator_proof_at)
  VALUES (v_user, v_auth, p_session, p_code_hash, p_primary_side, clock_timestamp() + interval '4 minutes',
          r_user, r_auth, CASE WHEN r_user IS NULL THEN NULL ELSE v_mail END, clock_timestamp());
  INSERT INTO signin_link_audit(actor_user_id, counterpart_user_id, action) VALUES (v_user, r_user, 'challenge.started');
  RETURN 'started';
EXCEPTION WHEN unique_violation THEN
  RETURN 'invalid';
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION signin_link_complete(p_session text, p_code_hash text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid; v_auth text;
  c signin_link_challenges%ROWTYPE;
  v_locked_init uuid;
  i_user uuid; i_auth text; i_fresh boolean;
  r_user uuid; r_auth text; r_fresh boolean;
  v_low uuid; v_high uuid; v_link uuid; v_failures integer; v_ok boolean;
BEGIN
  IF p_code_hash !~ '^[0-9a-f]{64}$' THEN RETURN 'invalid'; END IF;
  SELECT c2.user_id, c2.auth_user_id INTO v_user, v_auth FROM signin_link_consume(p_session, 'complete') c2;
  IF v_user IS NULL THEN RETURN 'not_fresh'; END IF;

  SELECT * INTO c FROM signin_link_challenges WHERE code_hash = p_code_hash AND closed_at IS NULL;
  IF FOUND AND c.recipient_user_id IS NOT NULL AND c.initiator_user_id <> v_user THEN
    -- Advisory locks, then both users rows, each in canonical order. Held through the link insert.
    PERFORM pg_advisory_xact_lock(hashtextextended('signin-link:' || LEAST(v_user, c.initiator_user_id)::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('signin-link:' || GREATEST(v_user, c.initiator_user_id)::text, 0));
    PERFORM 1 FROM users WHERE id = LEAST(v_user, c.initiator_user_id) FOR UPDATE;
    PERFORM 1 FROM users WHERE id = GREATEST(v_user, c.initiator_user_id) FOR UPDATE;
    v_locked_init := c.initiator_user_id;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('signin-link:' || v_user::text, 0));
  END IF;

  -- Everything below is read after the lock wait, with wall-clock time.
  SELECT p.user_id, p.auth_user_id, p.fresh INTO r_user, r_auth, r_fresh FROM signin_link_proof(p_session, 300) p;
  IF r_user IS DISTINCT FROM v_user OR r_auth IS DISTINCT FROM v_auth OR r_fresh IS NOT TRUE THEN
    RETURN 'not_fresh';
  END IF;

  -- Guess limit: five misses per redeeming account per fifteen minutes.
  INSERT INTO signin_link_failures(user_id, failures, window_started_at) VALUES (v_user, 0, now())
    ON CONFLICT (user_id) DO UPDATE SET
      failures = CASE WHEN signin_link_failures.window_started_at < now() - interval '15 minutes'
                      THEN 0 ELSE signin_link_failures.failures END,
      window_started_at = CASE WHEN signin_link_failures.window_started_at < now() - interval '15 minutes'
                      THEN now() ELSE signin_link_failures.window_started_at END
    RETURNING failures INTO v_failures;
  IF v_failures >= 5 THEN RETURN 'locked'; END IF;

  SELECT * INTO c FROM signin_link_challenges
   WHERE code_hash = p_code_hash AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR c.expires_at <= clock_timestamp() THEN
    UPDATE signin_link_failures SET failures = failures + 1 WHERE user_id = v_user;
    IF FOUND AND c.id IS NOT NULL THEN
      UPDATE signin_link_challenges SET closed_at = now(), outcome = 'expired' WHERE id = c.id;
    END IF;
    RETURN 'invalid';
  END IF;
  -- The locks were taken for the challenge read before them; it must be the same pair.
  IF c.recipient_user_id IS NOT NULL AND c.initiator_user_id IS DISTINCT FROM v_locked_init THEN
    UPDATE signin_link_failures SET failures = failures + 1 WHERE user_id = v_user;
    RETURN 'invalid';
  END IF;

  -- Only the intended recipient, same sign-in id, and still the single verified owner of the address
  -- (verified alias OR verified Better Auth address; none if two accounts claim it).
  SELECT EXISTS (SELECT 1 FROM signin_link_email_owner(c.recipient_email) o
                  WHERE o.user_id = v_user AND o.auth_user_id = v_auth) INTO v_ok;
  IF c.recipient_user_id IS DISTINCT FROM v_user OR c.recipient_auth_user_id IS DISTINCT FROM v_auth OR NOT v_ok THEN
    UPDATE signin_link_failures SET failures = failures + 1 WHERE user_id = v_user;
    RETURN 'invalid';
  END IF;

  SELECT user_id, auth_user_id, fresh INTO i_user, i_auth, i_fresh FROM signin_link_proof(c.initiator_session_id, 300);
  IF i_user IS NULL OR i_user <> c.initiator_user_id OR i_auth <> c.initiator_auth_user_id
     OR i_fresh IS NOT TRUE OR c.initiator_proof_at IS NULL OR c.initiator_proof_at < clock_timestamp() - interval '5 minutes' THEN
    UPDATE signin_link_challenges SET closed_at = now(), outcome = 'expired' WHERE id = c.id;
    RETURN 'invalid';
  END IF;
  IF i_user = v_user OR i_auth = v_auth THEN RETURN 'same_account'; END IF;
  PERFORM signin_link_sweep(v_user); PERFORM signin_link_sweep(i_user);
  IF signin_link_unsettled(v_user, v_auth) OR signin_link_unsettled(i_user, i_auth) THEN RETURN 'unsettled'; END IF;

  v_low := LEAST(v_user, i_user); v_high := GREATEST(v_user, i_user);
  IF EXISTS (SELECT 1 FROM signin_links WHERE user_low = v_low AND user_high = v_high AND revoked_at IS NULL) THEN
    UPDATE signin_link_challenges SET closed_at = now(), outcome = 'superseded' WHERE id = c.id;
    RETURN 'exists';
  END IF;
  IF (SELECT count(*) FROM signin_links WHERE revoked_at IS NULL AND v_user IN (user_low, user_high)) >= 5
     OR (SELECT count(*) FROM signin_links WHERE revoked_at IS NULL AND i_user IN (user_low, user_high)) >= 5 THEN
    RETURN 'limit';
  END IF;

  BEGIN
    INSERT INTO signin_links(user_low, user_high, auth_user_low, auth_user_high, primary_user_id, initiator_user_id)
    VALUES (v_low, v_high,
            CASE WHEN v_low = v_user THEN v_auth ELSE i_auth END,
            CASE WHEN v_high = v_user THEN v_auth ELSE i_auth END,
            CASE WHEN c.primary_side = 'initiator' THEN i_user ELSE v_user END,
            i_user)
    RETURNING id INTO v_link;
  EXCEPTION WHEN unique_violation THEN
    UPDATE signin_link_challenges SET closed_at = now(), outcome = 'superseded' WHERE id = c.id;
    RETURN 'exists';
  END;
  UPDATE signin_link_challenges SET closed_at = now(), outcome = 'linked' WHERE id = c.id;
  UPDATE signin_link_failures SET failures = 0 WHERE user_id = v_user;
  INSERT INTO signin_link_audit(link_id, actor_user_id, counterpart_user_id, action)
  VALUES (v_link, v_user, i_user, 'link.created');
  RETURN 'linked';
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION signin_link_start(text, text, text, text), signin_link_complete(text, text)
  FROM PUBLIC, portal_app, portal_auth;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION signin_link_start(text, text, text, text), signin_link_complete(text, text) TO portal_auth;
