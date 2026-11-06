-- Hardening of verified sign-in links (supersedes the function bodies of 0062/0063).
--
--  1. The challenge is bound at issue to ONE intended recipient: the account that
--     owns a VERIFIED address the initiator typed. Only that account (and sign-in
--     id) can redeem. An unknown/unverified/own address yields the same
--     'started' answer and a code that nobody can redeem (no enumeration).
--  2. Both proofs are enforced with bounded timestamps. Each mutation needs a
--     single-use attestation minted right after the action's own TOTP check
--     (session mfa_verified_at within 60s), so an ordinary session id alone, or
--     a TOTP from sign-in time, cannot drive a mutation.
--  3. Mutations, discovery and pair history run only as portal_auth (the sign-in
--     engine pool), never portal_app. Discovery is limited to an account that
--     currently holds a live authenticator-verified session.
--  4. Acceptance serializes on both identities in stable order, rechecks both
--     caps at completion, and answers a reverse duplicate with 'exists'.
--  5. A link whose sign-in id changed or whose account is deleted/service is
--     revoked for good (trigger + read-time sweep); it never revives, and the
--     legacy fallback stays suppressed through signin_link_pair_history.
-- Additive and replayable. No link is created and no tenant data is touched.

ALTER TABLE signin_link_challenges
  ADD COLUMN IF NOT EXISTS recipient_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS recipient_auth_user_id text,
  ADD COLUMN IF NOT EXISTS recipient_email text,
  ADD COLUMN IF NOT EXISTS initiator_proof_at timestamptz;
--> statement-breakpoint
-- Challenges predating this migration have no recipient: they can never be redeemed.
UPDATE signin_link_challenges SET closed_at = now(), outcome = 'expired' WHERE closed_at IS NULL AND recipient_user_id IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS signin_link_attestations (
  session_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('start', 'complete', 'revoke')),
  user_id uuid NOT NULL,
  mfa_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, purpose)
);
--> statement-breakpoint
ALTER TABLE signin_link_attestations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON signin_link_attestations FROM PUBLIC, portal_app, portal_auth;
--> statement-breakpoint

-- Old signatures are removed so nothing can still call them.
DROP FUNCTION IF EXISTS signin_link_start(text, text, text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS signin_link_complete(text, text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS signin_link_revoke(text, uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS signin_links_for(uuid);
--> statement-breakpoint

-- Called by the server action immediately AFTER its own TOTP check succeeded.
CREATE OR REPLACE FUNCTION signin_link_attest(p_session text, p_purpose text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid; v_at timestamptz;
BEGIN
  IF p_purpose NOT IN ('start', 'complete', 'revoke') THEN RETURN false; END IF;
  SELECT p.user_id, s.mfa_verified_at INTO v_user, v_at
    FROM signin_link_proof(p_session, 60) p JOIN auth_sessions s ON s.id = p_session
   WHERE p.fresh;
  IF v_user IS NULL THEN RETURN false; END IF;
  INSERT INTO signin_link_attestations(session_id, purpose, user_id, mfa_at, expires_at)
  VALUES (p_session, p_purpose, v_user, v_at, now() + interval '2 minutes')
  ON CONFLICT (session_id, purpose) DO UPDATE
    SET user_id = excluded.user_id, mfa_at = excluded.mfa_at, expires_at = excluded.expires_at;
  RETURN true;
END
$$;
--> statement-breakpoint

-- Single use. Fails unless the attestation is unexpired and the session's
-- authenticator time has not moved since (and is still within 5 minutes).
CREATE OR REPLACE FUNCTION signin_link_consume(p_session text, p_purpose text) RETURNS TABLE(user_id uuid, auth_user_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH a AS (
    DELETE FROM signin_link_attestations
     WHERE session_id = p_session AND purpose = p_purpose AND expires_at > now()
    RETURNING user_id, mfa_at
  )
  SELECT p.user_id, p.auth_user_id
    FROM a JOIN signin_link_proof(p_session, 300) p ON p.user_id = a.user_id AND p.fresh
    JOIN auth_sessions s ON s.id = p_session AND s.mfa_verified_at = a.mfa_at;
$$;
--> statement-breakpoint

-- Revoke, permanently, every active link of p_user whose binding no longer holds.
CREATE OR REPLACE FUNCTION signin_link_sweep(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT l.id, l.user_low, l.user_high FROM signin_links l
      JOIN users lo ON lo.id = l.user_low JOIN users hi ON hi.id = l.user_high
     WHERE l.revoked_at IS NULL AND p_user IN (l.user_low, l.user_high)
       AND (lo.deleted_at IS NOT NULL OR lo.is_service OR hi.deleted_at IS NOT NULL OR hi.is_service
            OR lo.auth_user_id IS DISTINCT FROM l.auth_user_low OR hi.auth_user_id IS DISTINCT FROM l.auth_user_high)
     FOR UPDATE OF l
  LOOP
    UPDATE signin_links SET revoked_at = now() WHERE id = r.id;
    INSERT INTO signin_link_audit(link_id, counterpart_user_id, action) VALUES (r.id, p_user, 'link.revoked_invalid');
  END LOOP;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION signin_link_users_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
     OR (NEW.is_service AND NOT OLD.is_service) THEN
    PERFORM signin_link_sweep(NEW.id);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS signin_link_users_changed ON users;
--> statement-breakpoint
CREATE TRIGGER signin_link_users_changed AFTER UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION signin_link_users_changed();
--> statement-breakpoint
-- Close out anything already invalid when this migration runs.
SELECT signin_link_sweep(u.id) FROM users u
  WHERE EXISTS (SELECT 1 FROM signin_links l WHERE l.revoked_at IS NULL AND u.id IN (l.user_low, l.user_high));
--> statement-breakpoint

-- Side A. p_recipient is the verified address of the intended second account.
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
  -- Authoritative lookup: a VERIFIED address of a live, human, bound, other account.
  SELECT u.id, u.auth_user_id INTO r_user, r_auth
    FROM user_emails e JOIN users u ON u.id = e.user_id
   WHERE lower(e.email) = v_mail AND e.verified_at IS NOT NULL
     AND u.deleted_at IS NULL AND NOT u.is_service AND u.auth_user_id IS NOT NULL
     AND u.id <> v_user AND u.auth_user_id <> v_auth;
  UPDATE signin_link_challenges SET closed_at = now(),
         outcome = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'superseded' END
   WHERE initiator_user_id = v_user AND closed_at IS NULL;
  -- No match still answers 'started'; the stored challenge has no recipient and is unredeemable.
  INSERT INTO signin_link_challenges(initiator_user_id, initiator_auth_user_id, initiator_session_id,
                                     code_hash, primary_side, expires_at,
                                     recipient_user_id, recipient_auth_user_id, recipient_email, initiator_proof_at)
  VALUES (v_user, v_auth, p_session, p_code_hash, p_primary_side, now() + interval '4 minutes',
          r_user, r_auth, CASE WHEN r_user IS NULL THEN NULL ELSE v_mail END, now());
  INSERT INTO signin_link_audit(actor_user_id, counterpart_user_id, action) VALUES (v_user, r_user, 'challenge.started');
  RETURN 'started';
EXCEPTION WHEN unique_violation THEN
  RETURN 'invalid';
END
$$;
--> statement-breakpoint

-- Side B.
CREATE OR REPLACE FUNCTION signin_link_complete(p_session text, p_code_hash text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid; v_auth text;
  c signin_link_challenges%ROWTYPE;
  i_user uuid; i_auth text; i_fresh boolean;
  v_low uuid; v_high uuid; v_link uuid; v_failures integer; v_ok boolean;
BEGIN
  IF p_code_hash !~ '^[0-9a-f]{64}$' THEN RETURN 'invalid'; END IF;
  SELECT c2.user_id, c2.auth_user_id INTO v_user, v_auth FROM signin_link_consume(p_session, 'complete') c2;
  IF v_user IS NULL THEN RETURN 'not_fresh'; END IF;

  SELECT * INTO c FROM signin_link_challenges WHERE code_hash = p_code_hash AND closed_at IS NULL;
  -- Serialize both identities in stable order, then re-read the challenge under lock.
  IF FOUND AND c.recipient_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('signin-link:' || LEAST(v_user, c.initiator_user_id)::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('signin-link:' || GREATEST(v_user, c.initiator_user_id)::text, 0));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('signin-link:' || v_user::text, 0));
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
  IF NOT FOUND OR c.expires_at <= now() THEN
    UPDATE signin_link_failures SET failures = failures + 1 WHERE user_id = v_user;
    IF FOUND AND c.id IS NOT NULL THEN
      UPDATE signin_link_challenges SET closed_at = now(), outcome = 'expired' WHERE id = c.id;
    END IF;
    RETURN 'invalid';
  END IF;

  -- Only the intended recipient, with the sign-in id captured at issue, still owning that verified address.
  SELECT EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = v_user AND lower(e.email) = c.recipient_email
                    AND e.verified_at IS NOT NULL) INTO v_ok;
  IF c.recipient_user_id IS DISTINCT FROM v_user OR c.recipient_auth_user_id IS DISTINCT FROM v_auth OR NOT v_ok THEN
    UPDATE signin_link_failures SET failures = failures + 1 WHERE user_id = v_user;
    RETURN 'invalid';
  END IF;

  -- The initiating sign-in must still be live, the same stable identity, and fresh (bounded) too.
  SELECT user_id, auth_user_id, fresh INTO i_user, i_auth, i_fresh FROM signin_link_proof(c.initiator_session_id, 300);
  IF i_user IS NULL OR i_user <> c.initiator_user_id OR i_auth <> c.initiator_auth_user_id
     OR i_fresh IS NOT TRUE OR c.initiator_proof_at IS NULL OR c.initiator_proof_at < now() - interval '5 minutes' THEN
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
  -- Both caps, rechecked under the locks.
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

CREATE OR REPLACE FUNCTION signin_link_revoke(p_session text, p_link uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid; l signin_links%ROWTYPE;
BEGIN
  SELECT c.user_id INTO v_user FROM signin_link_consume(p_session, 'revoke') c;
  IF v_user IS NULL THEN RETURN 'not_fresh'; END IF;
  SELECT * INTO l FROM signin_links WHERE id = p_link AND revoked_at IS NULL
     AND v_user IN (user_low, user_high) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  UPDATE signin_links SET revoked_at = now(), revoked_by = v_user WHERE id = l.id;
  INSERT INTO signin_link_audit(link_id, actor_user_id, counterpart_user_id, action)
  VALUES (l.id, v_user, CASE WHEN l.user_low = v_user THEN l.user_high ELSE l.user_low END, 'link.revoked');
  RETURN 'revoked';
END
$$;
--> statement-breakpoint

-- Discovery. Volatile (it sweeps). Only for an account that currently holds a
-- live authenticator-verified session; any other id yields nothing.
CREATE OR REPLACE FUNCTION signin_links_for(p_user uuid)
RETURNS TABLE(link_id uuid, partner_user_id uuid, partner_email text, partner_name text,
              partner_is_primary boolean, verified_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users me JOIN auth_sessions s ON s.user_id = me.auth_user_id
                  WHERE me.id = p_user AND me.deleted_at IS NULL AND NOT me.is_service
                    AND s.expires_at > now() AND s.mfa_verified_at IS NOT NULL) THEN
    RETURN;
  END IF;
  PERFORM signin_link_sweep(p_user);
  RETURN QUERY
  SELECT l.id, o.id, o.email, coalesce(o.full_name, o.email), l.primary_user_id = o.id, l.verified_at
    FROM signin_links l
    JOIN users me ON me.id = p_user AND me.id IN (l.user_low, l.user_high)
    JOIN users o ON o.id = CASE WHEN l.user_low = me.id THEN l.user_high ELSE l.user_low END
   WHERE l.revoked_at IS NULL
     AND me.deleted_at IS NULL AND NOT me.is_service AND o.deleted_at IS NULL AND NOT o.is_service
     AND me.auth_user_id = CASE WHEN l.user_low = me.id THEN l.auth_user_low ELSE l.auth_user_high END
     AND o.auth_user_id  = CASE WHEN l.user_low = o.id  THEN l.auth_user_low ELSE l.auth_user_high END
   ORDER BY l.verified_at, l.id;
END
$$;
--> statement-breakpoint

-- History (active or revoked) for the legacy-fallback suppression; same scoping.
CREATE OR REPLACE FUNCTION signin_link_pair_history(p_user uuid, p_other uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM signin_links l
                  WHERE l.user_low = LEAST(p_user, p_other) AND l.user_high = GREATEST(p_user, p_other));
$$;
--> statement-breakpoint

-- ACLs: portal_auth only. portal_app can execute none of it. Helpers: nobody.
REVOKE ALL ON FUNCTION signin_link_start(text, text, text, text), signin_link_complete(text, text),
  signin_link_revoke(text, uuid), signin_links_for(uuid), signin_link_pair_history(uuid, uuid),
  signin_link_attest(text, text), signin_link_consume(text, text), signin_link_sweep(uuid),
  signin_link_users_changed() FROM PUBLIC, portal_app, portal_auth;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION signin_link_start(text, text, text, text), signin_link_complete(text, text),
  signin_link_revoke(text, uuid), signin_links_for(uuid), signin_link_pair_history(uuid, uuid),
  signin_link_attest(text, text) TO portal_auth;
