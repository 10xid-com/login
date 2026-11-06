-- Verified sign-in links: a durable, mutual association between two portal
-- accounts, so a person who holds two sign-ins can SEE the businesses of both
-- from one (My Businesses). A link is for discovery only. It grants no role,
-- no tool permission and no CiD access; every authorization still rests on the
-- signed-in account's own membership/permission rows.
--
-- Proof: each side must hold its own live sign-in session that has passed the
-- authenticator within the last five minutes (auth_sessions.mfa_verified_at).
-- Side A starts a challenge from its session; side B, in a different session of
-- a different account, redeems the one-time code. Both are checked here, in the
-- database, against auth_sessions, not taken on the caller's word.
--
-- Additive and replayable. Creates no link: nothing is seeded or migrated. The
-- legacy two-account Rana compatibility in the application is NOT converted.
-- No tenant data is touched.

CREATE TABLE IF NOT EXISTS signin_link_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_user_id uuid NOT NULL REFERENCES users(id),
  initiator_auth_user_id text NOT NULL,
  initiator_session_id text NOT NULL,
  code_hash text NOT NULL,
  -- Which account is the PRIMARY sign-in of the link: a presentation label.
  primary_side text NOT NULL CHECK (primary_side IN ('initiator', 'redeemer')),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  outcome text CHECK (outcome IN ('linked', 'superseded', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One open challenge per initiating account; a new start supersedes the old.
CREATE UNIQUE INDEX IF NOT EXISTS signin_link_challenges_one_open
  ON signin_link_challenges(initiator_user_id) WHERE closed_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS signin_link_challenges_open_code
  ON signin_link_challenges(code_hash) WHERE closed_at IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS signin_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored in canonical order so a pair has exactly one row.
  user_low uuid NOT NULL REFERENCES users(id),
  user_high uuid NOT NULL REFERENCES users(id),
  -- The stable sign-in ids at the time of proof. Validity re-checks them.
  auth_user_low text NOT NULL,
  auth_user_high text NOT NULL,
  primary_user_id uuid NOT NULL,
  initiator_user_id uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  CHECK (user_low < user_high),
  CHECK (auth_user_low <> auth_user_high),
  CHECK (primary_user_id IN (user_low, user_high)),
  CHECK (initiator_user_id IN (user_low, user_high))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS signin_links_pair_active
  ON signin_links(user_low, user_high) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS signin_links_low ON signin_links(user_low) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS signin_links_high ON signin_links(user_high) WHERE revoked_at IS NULL;
--> statement-breakpoint

-- Failed redemptions per redeeming account: bounds guessing of the code.
CREATE TABLE IF NOT EXISTS signin_link_failures (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  failures integer NOT NULL,
  window_started_at timestamptz NOT NULL
);
--> statement-breakpoint

-- Append-only record. No tenant: a link belongs to people, not to a business.
CREATE TABLE IF NOT EXISTS signin_link_audit (
  id bigserial PRIMARY KEY,
  link_id uuid,
  actor_user_id uuid,
  counterpart_user_id uuid,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION signin_link_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'signin_link_audit is append-only';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS signin_link_audit_no_change ON signin_link_audit;
--> statement-breakpoint
CREATE TRIGGER signin_link_audit_no_change BEFORE UPDATE OR DELETE ON signin_link_audit
  FOR EACH ROW EXECUTE FUNCTION signin_link_audit_append_only();
--> statement-breakpoint

-- The application role has NO direct access. Everything goes through the
-- SECURITY DEFINER functions below, which check the sessions themselves.
ALTER TABLE signin_link_challenges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE signin_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE signin_link_failures ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE signin_link_audit ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON signin_link_challenges, signin_links, signin_link_failures, signin_link_audit
  FROM PUBLIC, portal_app, portal_auth;
--> statement-breakpoint

-- A session's account, only if the session is live and passed the authenticator
-- no more than p_fresh seconds ago, and the account is a live, bound human one.
-- Returns no row otherwise. Internal helper, not granted to anyone.
CREATE OR REPLACE FUNCTION signin_link_proof(p_session text, p_fresh integer)
RETURNS TABLE(user_id uuid, auth_user_id text, fresh boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.auth_user_id,
         s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at > now() - make_interval(secs => p_fresh)
    FROM auth_sessions s
    JOIN users u ON u.auth_user_id = s.user_id AND u.deleted_at IS NULL AND NOT u.is_service
   WHERE s.id = p_session AND s.expires_at > now() AND s.mfa_verified_at IS NOT NULL;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION signin_link_proof(text, integer) FROM PUBLIC, portal_app, portal_auth;
--> statement-breakpoint

-- Is something else already pending for either identity (an unanswered
-- operator binding request)? Then the account's identity is not settled.
CREATE OR REPLACE FUNCTION signin_link_unsettled(p_user uuid, p_auth text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM identity_bindings b
                  WHERE b.decision IS NULL AND (b.user_id = p_user OR b.auth_user_id = p_auth));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION signin_link_unsettled(uuid, text) FROM PUBLIC, portal_app, portal_auth;
--> statement-breakpoint

-- Side A: open a challenge bound to this session. Returns the outcome only.
CREATE OR REPLACE FUNCTION signin_link_start(p_session text, p_code_hash text, p_primary_side text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid; v_auth text; v_fresh boolean;
BEGIN
  IF p_primary_side NOT IN ('initiator', 'redeemer') OR p_code_hash !~ '^[0-9a-f]{64}$' THEN RETURN 'invalid'; END IF;
  SELECT user_id, auth_user_id, fresh INTO v_user, v_auth, v_fresh FROM signin_link_proof(p_session, 600);
  IF v_user IS NULL THEN RETURN 'no_session'; END IF;
  SELECT fresh INTO v_fresh FROM signin_link_proof(p_session, 300);
  IF v_fresh IS NOT TRUE THEN RETURN 'not_fresh'; END IF;
  IF signin_link_unsettled(v_user, v_auth) THEN RETURN 'unsettled'; END IF;
  IF (SELECT count(*) FROM signin_links WHERE revoked_at IS NULL AND v_user IN (user_low, user_high)) >= 5 THEN
    RETURN 'limit';
  END IF;
  UPDATE signin_link_challenges SET closed_at = now(),
         outcome = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'superseded' END
   WHERE initiator_user_id = v_user AND closed_at IS NULL;
  INSERT INTO signin_link_challenges(initiator_user_id, initiator_auth_user_id, initiator_session_id,
                                     code_hash, primary_side, expires_at)
  VALUES (v_user, v_auth, p_session, p_code_hash, p_primary_side, now() + interval '10 minutes');
  INSERT INTO signin_link_audit(actor_user_id, action) VALUES (v_user, 'challenge.started');
  RETURN 'started';
EXCEPTION WHEN unique_violation THEN
  RETURN 'invalid';
END
$$;
--> statement-breakpoint

-- Side B: prove control of the second account and consume the challenge.
CREATE OR REPLACE FUNCTION signin_link_complete(p_session text, p_code_hash text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid; v_auth text; v_fresh boolean;
  c signin_link_challenges%ROWTYPE;
  i_user uuid; i_auth text; i_fresh boolean;
  v_low uuid; v_high uuid; v_link uuid; v_failures integer;
BEGIN
  IF p_code_hash !~ '^[0-9a-f]{64}$' THEN RETURN 'invalid'; END IF;
  SELECT user_id, auth_user_id INTO v_user, v_auth FROM signin_link_proof(p_session, 600);
  IF v_user IS NULL THEN RETURN 'no_session'; END IF;
  SELECT fresh INTO v_fresh FROM signin_link_proof(p_session, 300);
  IF v_fresh IS NOT TRUE THEN RETURN 'not_fresh'; END IF;

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

  -- The initiating sign-in must still be live, and still the same stable identity.
  SELECT user_id, auth_user_id, fresh INTO i_user, i_auth, i_fresh FROM signin_link_proof(c.initiator_session_id, 600);
  IF i_user IS NULL OR i_user <> c.initiator_user_id OR i_auth <> c.initiator_auth_user_id THEN
    UPDATE signin_link_challenges SET closed_at = now(), outcome = 'expired' WHERE id = c.id;
    RETURN 'invalid';
  END IF;
  IF i_user = v_user OR i_auth = v_auth THEN RETURN 'same_account'; END IF;
  IF signin_link_unsettled(v_user, v_auth) OR signin_link_unsettled(i_user, i_auth) THEN RETURN 'unsettled'; END IF;
  IF (SELECT count(*) FROM signin_links WHERE revoked_at IS NULL AND v_user IN (user_low, user_high)) >= 5 THEN
    RETURN 'limit';
  END IF;

  v_low := LEAST(v_user, i_user); v_high := GREATEST(v_user, i_user);
  IF EXISTS (SELECT 1 FROM signin_links WHERE user_low = v_low AND user_high = v_high AND revoked_at IS NULL) THEN
    UPDATE signin_link_challenges SET closed_at = now(), outcome = 'superseded' WHERE id = c.id;
    RETURN 'exists';
  END IF;

  INSERT INTO signin_links(user_low, user_high, auth_user_low, auth_user_high, primary_user_id, initiator_user_id)
  VALUES (v_low, v_high,
          CASE WHEN v_low = v_user THEN v_auth ELSE i_auth END,
          CASE WHEN v_high = v_user THEN v_auth ELSE i_auth END,
          CASE WHEN c.primary_side = 'initiator' THEN i_user ELSE v_user END,
          i_user)
  RETURNING id INTO v_link;
  UPDATE signin_link_challenges SET closed_at = now(), outcome = 'linked' WHERE id = c.id;
  UPDATE signin_link_failures SET failures = 0 WHERE user_id = v_user;
  INSERT INTO signin_link_audit(link_id, actor_user_id, counterpart_user_id, action)
  VALUES (v_link, v_user, i_user, 'link.created');
  RETURN 'linked';
END
$$;
--> statement-breakpoint

-- Either linked account may end a link, from its own fresh sign-in.
CREATE OR REPLACE FUNCTION signin_link_revoke(p_session text, p_link uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid; v_fresh boolean; l signin_links%ROWTYPE;
BEGIN
  SELECT user_id INTO v_user FROM signin_link_proof(p_session, 600);
  IF v_user IS NULL THEN RETURN 'no_session'; END IF;
  SELECT fresh INTO v_fresh FROM signin_link_proof(p_session, 300);
  IF v_fresh IS NOT TRUE THEN RETURN 'not_fresh'; END IF;
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

-- Discovery: who is verifiably linked to this account. Read-only, direct links
-- only (never transitive), and only while both ends are still live, human,
-- and bound to the same sign-in ids that were proven. The caller passes the
-- account id it has ALREADY authenticated; this reveals only that account's own
-- partners, and it grants nothing.
CREATE OR REPLACE FUNCTION signin_links_for(p_user uuid)
RETURNS TABLE(link_id uuid, partner_user_id uuid, partner_email text, partner_name text,
              partner_is_primary boolean, verified_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, o.id, o.email, coalesce(o.full_name, o.email), l.primary_user_id = o.id, l.verified_at
    FROM signin_links l
    JOIN users me ON me.id = p_user AND me.id IN (l.user_low, l.user_high)
    JOIN users o ON o.id = CASE WHEN l.user_low = me.id THEN l.user_high ELSE l.user_low END
   WHERE l.revoked_at IS NULL
     AND me.deleted_at IS NULL AND NOT me.is_service AND o.deleted_at IS NULL AND NOT o.is_service
     AND me.auth_user_id = CASE WHEN l.user_low = me.id THEN l.auth_user_low ELSE l.auth_user_high END
     AND o.auth_user_id  = CASE WHEN l.user_low = o.id  THEN l.auth_user_low ELSE l.auth_user_high END
   ORDER BY l.verified_at, l.id;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION signin_link_start(text, text, text), signin_link_complete(text, text),
  signin_link_revoke(text, uuid), signin_links_for(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION signin_link_start(text, text, text), signin_link_complete(text, text),
  signin_link_revoke(text, uuid), signin_links_for(uuid) TO portal_app;
