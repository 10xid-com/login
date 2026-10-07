-- 0022 — SIGN-IN ON OUR OWN INFRASTRUCTURE: BETTER AUTH.
--
-- Replaces the pending WorkOS plan (0021's columns stay, unused: migrations
-- here are additive). Better Auth runs inside the login host
-- (10xid-com/login, login.10xid.com); the portal (app.10xid.com) keeps its own
-- session, handed over by the single-use ticket as before.
--
--   1. A new restricted role, portal_auth, for the sign-in tables only.
--   2. The Better Auth tables: auth_users, auth_sessions, auth_accounts,
--      auth_verifications, auth_two_factors, auth_rate_limits.
--   3. The session clocks, enforced here rather than in application code:
--      a hard seven days from sign-in that activity can never extend, and a
--      48-hour inactivity limit.
--   4. users.auth_user_id — the identity key — bound once, operator-only on an
--      existing account, exactly as 0021 did for WorkOS.
--   5. identity_bindings and the handoff (sso_tickets, sessions) learn the
--      Better Auth ids.
--   6. Three narrow functions through which the portal checks and ends a
--      sign-in session without being able to read the sign-in tables.
--
-- Nothing is dropped and no existing row is changed. Replayable throughout.

-- ---------------------------------------------------------------------------
-- 1. The role.
--
-- portal_app is shared by both services (the portal's DATABASE_APP_URL is a
-- reference to the login host's). The sign-in tables hold password hashes,
-- encrypted authenticator secrets and recovery codes, and one-time codes, so
-- they get a role of their own, used only by the login host's Better Auth
-- connection (AUTH_DATABASE_URL). Created without a password: the deploy step
-- (scripts/migrate.mjs) gives it LOGIN and its password from
-- PORTAL_AUTH_PASSWORD, as it does for portal_app.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_auth') THEN
    CREATE ROLE portal_auth NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO portal_auth;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. The tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "auth_users" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean DEFAULT false NOT NULL,
  "image" text,
  "two_factor_enabled" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_users_email_unique" UNIQUE ("email")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL,
  "user_id" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "mfa_verified_at" timestamp with time zone,
  "first_factor" text,
  "last_active_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_sessions_token_unique" UNIQUE ("token"),
  CONSTRAINT "auth_sessions_user_id_auth_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_sessions_user_idx" ON "auth_sessions" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "auth_accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp with time zone,
  "refresh_token_expires_at" timestamp with time zone,
  "scope" text,
  "password" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_accounts_user_id_auth_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_accounts_user_idx" ON "auth_accounts" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_accounts_provider_account_idx"
  ON "auth_accounts" ("provider_id", "account_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "auth_verifications" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_verifications_identifier_idx" ON "auth_verifications" ("identifier");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "auth_two_factors" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "secret" text NOT NULL,
  "backup_codes" text NOT NULL,
  "verified" boolean DEFAULT false NOT NULL,
  "failed_verification_count" integer DEFAULT 0 NOT NULL,
  "locked_until" timestamp with time zone,
  "last_used_step" bigint,
  "enrolling_session_id" text,
  CONSTRAINT "auth_two_factors_user_id_unique" UNIQUE ("user_id"),
  CONSTRAINT "auth_two_factors_user_id_auth_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_two_factors_secret_idx" ON "auth_two_factors" ("secret");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "auth_rate_limits" (
  "id" text PRIMARY KEY NOT NULL,
  "key" text NOT NULL,
  "count" integer NOT NULL,
  "last_request" bigint NOT NULL,
  CONSTRAINT "auth_rate_limits_key_unique" UNIQUE ("key")
);--> statement-breakpoint

-- The sign-in role, and nobody else. portal_app is refused explicitly, in
-- case a default privilege is ever added to the schema.
REVOKE ALL ON auth_users, auth_sessions, auth_accounts, auth_verifications,
  auth_two_factors, auth_rate_limits FROM PUBLIC, portal_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_users, auth_sessions, auth_accounts,
  auth_verifications, auth_two_factors, auth_rate_limits TO portal_auth;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. The session clocks.
--
-- Better Auth refreshes a session by writing a new expiry. Rather than trust
-- every code path to respect the policy, the row enforces it:
--
--   * on INSERT the database decides created_at and last_active_at, caps
--     expires_at at seven days, and clears mfa_verified_at — a new session
--     never starts as having passed the authenticator, whatever a caller
--     copies into it;
--   * on UPDATE created_at, user_id, token and first_factor cannot change, expires_at is
--     capped at created_at + 7 days (so activity never extends the maximum),
--     and last_active_at becomes now() — every refresh is activity;
--   * a policy hides from portal_auth any session past its expiry or idle for
--     48 hours, so Better Auth simply does not find it and the browser is
--     signed out, on every code path at once.
--
-- When a session is created, the same user's dead sessions are removed, so
-- expired and idle rows do not accumulate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_sessions_enforce_clocks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.last_active_at := now();
    NEW.mfa_verified_at := NULL;
    NEW.expires_at := least(NEW.expires_at, now() + interval '7 days');
  ELSE
    NEW.created_at := OLD.created_at;
    NEW.user_id := OLD.user_id;
    NEW.token := OLD.token;
    NEW.first_factor := OLD.first_factor;
    NEW.expires_at := least(NEW.expires_at, OLD.created_at + interval '7 days');
    NEW.last_active_at := now();
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS auth_sessions_enforce_clocks ON "auth_sessions";--> statement-breakpoint
CREATE TRIGGER auth_sessions_enforce_clocks
  BEFORE INSERT OR UPDATE ON "auth_sessions"
  FOR EACH ROW EXECUTE FUNCTION auth_sessions_enforce_clocks();--> statement-breakpoint

-- SECURITY DEFINER: as portal_auth the dead rows are exactly the ones its
-- policy hides, so they could never be found to delete.
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
     AND (expires_at <= now() OR created_at <= now() - interval '7 days'
          OR last_active_at <= now() - interval '48 hours');
  RETURN NULL;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS auth_sessions_purge_dead ON "auth_sessions";--> statement-breakpoint
CREATE TRIGGER auth_sessions_purge_dead
  AFTER INSERT ON "auth_sessions"
  FOR EACH ROW EXECUTE FUNCTION auth_sessions_purge_dead();--> statement-breakpoint

ALTER TABLE "auth_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS auth_sessions_live_read ON "auth_sessions";--> statement-breakpoint
CREATE POLICY auth_sessions_live_read ON "auth_sessions"
  FOR SELECT TO portal_auth
  USING (expires_at > now() AND created_at > now() - interval '7 days'
         AND last_active_at > now() - interval '48 hours');--> statement-breakpoint

DROP POLICY IF EXISTS auth_sessions_live_update ON "auth_sessions";--> statement-breakpoint
CREATE POLICY auth_sessions_live_update ON "auth_sessions"
  FOR UPDATE TO portal_auth
  USING (expires_at > now() AND created_at > now() - interval '7 days'
         AND last_active_at > now() - interval '48 hours')
  WITH CHECK (true);--> statement-breakpoint

DROP POLICY IF EXISTS auth_sessions_insert ON "auth_sessions";--> statement-breakpoint
CREATE POLICY auth_sessions_insert ON "auth_sessions"
  FOR INSERT TO portal_auth WITH CHECK (true);--> statement-breakpoint

DROP POLICY IF EXISTS auth_sessions_delete ON "auth_sessions";--> statement-breakpoint
CREATE POLICY auth_sessions_delete ON "auth_sessions"
  FOR DELETE TO portal_auth USING (true);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3b. The first proof of an address wipes what came before it.
--
-- An identity whose address is not yet proven carries no evidence that
-- anything attached to it belongs to the mailbox's owner: somebody else may
-- have signed up with that address and set a password, or set up an
-- authenticator. When the address is proven — an emailed sign-in code, or a
-- password reset by emailed code — provider links, the authenticator and
-- sessions from before are removed, whichever code path did the proving.
-- The password survives only if this same statement set it (a reset); Better
-- Auth's emailed-code sign-in has already removed it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_users_first_proof()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.email_verified AND NOT OLD.email_verified THEN
    DELETE FROM auth_two_factors WHERE user_id = NEW.id;
    DELETE FROM auth_accounts WHERE user_id = NEW.id AND provider_id <> 'credential';
    DELETE FROM auth_sessions WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS auth_users_first_proof ON "auth_users";--> statement-breakpoint
CREATE TRIGGER auth_users_first_proof
  BEFORE UPDATE OF email_verified ON "auth_users"
  FOR EACH ROW EXECUTE FUNCTION auth_users_first_proof();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. users.auth_user_id — bound once, and only an operator binds an existing
-- account. The same rule, and the same reasoning, as 0021's WorkOS column.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_user_id" text;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_auth_user_id_unique') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_auth_user_id_unique" UNIQUE ("auth_user_id");
  END IF;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION users_auth_user_id_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  table_owner oid;
BEGIN
  IF NEW.auth_user_id IS NOT DISTINCT FROM OLD.auth_user_id THEN
    RETURN NEW;
  END IF;

  IF OLD.auth_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'users.auth_user_id is set once and never changed (account %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT relowner INTO table_owner FROM pg_class WHERE oid = TG_RELID;
  IF NOT pg_has_role(current_user, table_owner, 'USAGE') THEN
    RAISE EXCEPTION 'Only an operator binds an existing account to a sign-in (account %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS users_auth_user_id_guard ON "users";--> statement-breakpoint
CREATE TRIGGER users_auth_user_id_guard
  BEFORE UPDATE OF "auth_user_id" ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_auth_user_id_guard();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5a. Binding requests carry the Better Auth user. workos_user_id becomes
-- optional (no row has ever been written with it in production), and exactly
-- one of the two is set on every row.
-- ---------------------------------------------------------------------------
ALTER TABLE "identity_bindings" ADD COLUMN IF NOT EXISTS "auth_user_id" text;--> statement-breakpoint
ALTER TABLE "identity_bindings" ALTER COLUMN "workos_user_id" DROP NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identity_bindings_one_subject') THEN
    ALTER TABLE "identity_bindings" ADD CONSTRAINT "identity_bindings_one_subject"
      CHECK (num_nonnulls("workos_user_id", "auth_user_id") = 1);
  END IF;
END
$$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "identity_bindings_auth_user_idx" ON "identity_bindings" ("auth_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_bindings_one_open_per_auth_user"
  ON "identity_bindings" ("auth_user_id") WHERE "decision" IS NULL AND "auth_user_id" IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5b. The handoff. A ticket and a portal session name the Better Auth session
-- they came from. The legacy source_session_id becomes optional; a ticket
-- still always names exactly where it came from.
-- ---------------------------------------------------------------------------
ALTER TABLE "sso_tickets" ADD COLUMN IF NOT EXISTS "source_auth_session_id" text;--> statement-breakpoint
ALTER TABLE "sso_tickets" ALTER COLUMN "source_session_id" DROP NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sso_tickets_has_source') THEN
    ALTER TABLE "sso_tickets" ADD CONSTRAINT "sso_tickets_has_source"
      CHECK ("source_session_id" IS NOT NULL OR "source_auth_session_id" IS NOT NULL);
  END IF;
END
$$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sso_tickets_auth_session_idx" ON "sso_tickets" ("source_auth_session_id");--> statement-breakpoint

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_auth_session_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_source_auth_session_idx" ON "sessions" ("source_auth_session_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. What the portal may do to a sign-in session, and nothing more.
--
-- SECURITY DEFINER, owned by the table owner, with a fixed search_path. The
-- portal (portal_app) may EXECUTE these and holds no privilege on the sign-in
-- tables, so it can ask whether a session is live, record activity on it, and
-- end it — and cannot read a token, a hash or a secret.
--
-- auth_session_touch: if the session is live and has passed the
-- authenticator, record activity (at most once a minute) and return the hard
-- end of the sign-in, created_at + 7 days. Otherwise NULL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_session_touch(p_session_id text)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  hard_end timestamptz;
BEGIN
  SELECT created_at + interval '7 days' INTO hard_end
    FROM auth_sessions
   WHERE id = p_session_id
     AND expires_at > now()
     AND created_at > now() - interval '7 days'
     AND last_active_at > now() - interval '48 hours'
     AND mfa_verified_at IS NOT NULL;
  IF hard_end IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE auth_sessions SET updated_at = now()
   WHERE id = p_session_id
     AND last_active_at < now() - interval '1 minute';

  RETURN least(hard_end, (SELECT expires_at FROM auth_sessions WHERE id = p_session_id));
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_revoke_session(p_session_id text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM auth_sessions WHERE id = p_session_id;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_revoke_user_sessions(p_auth_user_id text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH gone AS (DELETE FROM auth_sessions WHERE user_id = p_auth_user_id RETURNING 1)
  SELECT count(*)::integer FROM gone;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_session_touch(text), auth_revoke_session(text),
  auth_revoke_user_sessions(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_session_touch(text), auth_revoke_session(text),
  auth_revoke_user_sessions(text) TO portal_app;
