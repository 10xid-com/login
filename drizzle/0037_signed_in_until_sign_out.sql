-- 0037: a sign-in lasts until the person signs out.
--
-- 0022 gave every sign-in on the login host two clocks: a hard seven days from
-- signing in that activity could never extend, and 48 hours of inactivity.
-- Paolo's decision of 2026-10-13 is that people stay signed in until they sign
-- out themselves, so both clocks go:
--
--   * no inactivity limit — last_active_at is still recorded, and decides
--     nothing;
--   * no fixed end — every refresh moves expires_at to 400 days from now, so
--     a session that is used never ends on its own. 400 days is the browser's
--     own ceiling on a cookie (lib/auth/policy.ts, MAX_COOKIE_SECONDS); a
--     sign-in left unused for that long has lost its cookie anyway, and the
--     row lapses with it rather than outliving it.
--
-- What still ends a sign-in is unchanged: signing out (one session, or every
-- device), a password reset, a new authenticator or a recovery code, and an
-- operator's revocation. The portal session handed over from a sign-in still
-- checks it on every request (auth_session_touch), so ending the sign-in ends
-- the portal session on its next request, as before.
--
-- Unchanged too: a session is born without the authenticator, and created_at,
-- user_id, token and first_factor cannot be rewritten.
--
-- Additive and re-runnable: functions are replaced and policies recreated.
-- Sessions that are live when this runs simply carry on under the new rule;
-- ones that already lapsed stay ended.

CREATE OR REPLACE FUNCTION auth_sessions_enforce_clocks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.last_active_at := now();
    NEW.mfa_verified_at := NULL;
    NEW.expires_at := least(NEW.expires_at, now() + interval '400 days');
  ELSE
    NEW.created_at := OLD.created_at;
    NEW.user_id := OLD.user_id;
    NEW.token := OLD.token;
    NEW.first_factor := OLD.first_factor;
    NEW.expires_at := least(NEW.expires_at, now() + interval '400 days');
    NEW.last_active_at := now();
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_sessions_purge_dead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM auth_sessions
   WHERE user_id = NEW.user_id
     AND id <> NEW.id
     AND expires_at <= now();
  RETURN NULL;
END
$$;--> statement-breakpoint

DROP POLICY IF EXISTS auth_sessions_live_read ON "auth_sessions";--> statement-breakpoint
CREATE POLICY auth_sessions_live_read ON "auth_sessions"
  FOR SELECT TO portal_auth
  USING (expires_at > now());--> statement-breakpoint

DROP POLICY IF EXISTS auth_sessions_live_update ON "auth_sessions";--> statement-breakpoint
CREATE POLICY auth_sessions_live_update ON "auth_sessions"
  FOR UPDATE TO portal_auth
  USING (expires_at > now())
  WITH CHECK (true);--> statement-breakpoint

-- auth_session_touch: if the session is live and has passed the
-- authenticator, record activity (at most once a minute), which also moves
-- its end to 400 days from now, and return that end. Otherwise NULL.
CREATE OR REPLACE FUNCTION auth_session_touch(p_session_id text)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ends timestamptz;
BEGIN
  SELECT expires_at INTO ends
    FROM auth_sessions
   WHERE id = p_session_id
     AND expires_at > now()
     AND mfa_verified_at IS NOT NULL;
  IF ends IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE auth_sessions SET updated_at = now(), expires_at = now() + interval '400 days'
   WHERE id = p_session_id
     AND last_active_at < now() - interval '1 minute';

  RETURN (SELECT expires_at FROM auth_sessions WHERE id = p_session_id);
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_session_verified_at(p_session_id text)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT mfa_verified_at FROM auth_sessions
   WHERE id = p_session_id
     AND expires_at > now();
$$;--> statement-breakpoint

-- CREATE OR REPLACE keeps existing grants; restated so this file says them.
REVOKE ALL ON FUNCTION auth_session_touch(text), auth_session_verified_at(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_session_touch(text), auth_session_verified_at(text) TO portal_app;
