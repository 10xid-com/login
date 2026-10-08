-- 0025: agency grants.
--
-- An agency reaches a client's business only because that client said so:
-- for one role, for named people the client approved, for a fixed time, and
-- revocably. Nothing here creates or changes a membership — an agency person
-- never becomes a member of the client, and their access ends on its own.
--
-- Paolo's decisions of 2026-10-08:
--   * Branding Centres is the only agency to begin with (organizations.is_agency,
--     which only the table owner can set);
--   * editor by default, never owner;
--   * 90 days by default, a year at most;
--   * every agency person is approved by the client, one by one;
--   * agency access never lets anyone make permanent memberships or widen
--     their own access (the app strips those actions; the rules below make
--     the grant itself impossible to widen).
--
-- The rules are triggers, so they hold whatever the application does. Who may
-- decide is checked against the person named in the row (decided_by,
-- revoked_by, added_by): the application names the person asking, and the
-- database confirms that person holds the role the decision needs.
--
-- Also here, because the schema lives here:
--   * auth_session_verified_at(): when a sign-in last passed the
--     authenticator, for the portal's 24-hour and 5-minute rules;
--   * audit_events: an append-only, tenant-scoped record of grant decisions
--     and of what agency people do.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_agency boolean NOT NULL DEFAULT false;--> statement-breakpoint

UPDATE organizations SET is_agency = true
 WHERE slug = 'branding-centres' AND type = 'client' AND deleted_at IS NULL;--> statement-breakpoint

-- Which organizations are agencies is decided by whoever holds the database,
-- never by the portal: the application roles cannot set or clear the flag.
CREATE OR REPLACE FUNCTION organizations_agency_flag_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF session_user IN ('portal_app', 'portal_auth')
     AND (TG_OP = 'INSERT' AND NEW.is_agency
          OR TG_OP = 'UPDATE' AND NEW.is_agency IS DISTINCT FROM OLD.is_agency) THEN
    RAISE EXCEPTION 'Only the database owner decides which organizations are agencies.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS organizations_agency_flag_guard ON organizations;--> statement-breakpoint
CREATE TRIGGER organizations_agency_flag_guard
  BEFORE INSERT OR UPDATE OF is_agency ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_agency_flag_guard();--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE agency_grant_status AS ENUM ('requested', 'active', 'declined', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE agency_person_status AS ENUM ('requested', 'approved', 'declined', 'blocked', 'removed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS agency_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_organization_id uuid NOT NULL REFERENCES organizations(id),
  agency_organization_id uuid NOT NULL REFERENCES organizations(id),
  role membership_role NOT NULL DEFAULT 'editor',
  status agency_grant_status NOT NULL DEFAULT 'requested',
  reason text NOT NULL,
  duration_days integer NOT NULL DEFAULT 90,
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  expires_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  CONSTRAINT agency_grants_not_self CHECK (client_organization_id <> agency_organization_id),
  CONSTRAINT agency_grants_role_template CHECK (role IN ('manager', 'editor', 'publisher', 'asset_manager', 'viewer')),
  CONSTRAINT agency_grants_duration CHECK (duration_days BETWEEN 1 AND 365),
  CONSTRAINT agency_grants_reason_present CHECK (length(btrim(reason)) >= 8 AND length(reason) <= 500),
  CONSTRAINT agency_grants_expiry_bounded CHECK (
    expires_at IS NULL OR (decided_at IS NOT NULL AND expires_at <= decided_at + interval '365 days')
  ),
  CONSTRAINT agency_grants_active_has_clock CHECK (
    status <> 'active' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND expires_at IS NOT NULL)
  )
);--> statement-breakpoint

-- One open grant (asked for, or in force) per client and agency.
CREATE UNIQUE INDEX IF NOT EXISTS agency_grants_one_open_idx
  ON agency_grants (client_organization_id, agency_organization_id)
  WHERE status IN ('requested', 'active');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agency_grants_agency_idx ON agency_grants (agency_organization_id);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS agency_grant_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES agency_grants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status agency_person_status NOT NULL DEFAULT 'requested',
  added_by uuid NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  CONSTRAINT agency_grant_people_once UNIQUE (grant_id, user_id)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agency_grant_people_user_idx ON agency_grant_people (user_id);--> statement-breakpoint

-- A live account's membership of an organization, in one of these roles.
CREATE OR REPLACE FUNCTION agency_holds_role(p_user uuid, p_org uuid, p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.user_id = p_user AND m.organization_id = p_org
       AND m.role::text = ANY (p_roles)
       AND u.deleted_at IS NULL AND NOT u.is_service
  );
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION agency_holds_role(uuid, uuid, text[]) FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION agency_grants_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  every_role constant text[] := ARRAY['owner','manager','editor','publisher','asset_manager','viewer','member','staff'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL
       OR NEW.expires_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'A grant starts as a request.' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.agency_organization_id
                    AND is_agency AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Only an agency can ask for access.' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.client_organization_id
                    AND type = 'client' AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Access can only be asked of a live client business.' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT agency_holds_role(NEW.requested_by, NEW.agency_organization_id, ARRAY['owner','manager']) THEN
      RAISE EXCEPTION 'Only an owner or manager of the agency can ask for access.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE. What was asked for, by whom, and for how long never changes.
  IF NEW.client_organization_id <> OLD.client_organization_id
     OR NEW.agency_organization_id <> OLD.agency_organization_id
     OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at
     OR NEW.reason <> OLD.reason OR NEW.duration_days <> OLD.duration_days THEN
    RAISE EXCEPTION 'A request cannot be rewritten.' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status IN ('declined', 'revoked') THEN
    RAISE EXCEPTION 'A declined or revoked grant is closed.' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'requested' AND NEW.status = 'active' THEN
    -- The client's owner approves: the role (never owner), and a clock no
    -- longer than was asked for.
    IF NOT agency_holds_role(NEW.decided_by, NEW.client_organization_id, ARRAY['owner']) THEN
      RAISE EXCEPTION 'Only an owner of the business can approve agency access.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revoked_by IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Approving is not ending.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.decided_at := now();
    IF NEW.expires_at IS NULL OR NEW.expires_at > now() + make_interval(days => OLD.duration_days) THEN
      RAISE EXCEPTION 'Access can last no longer than was asked for.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status = 'requested' AND NEW.status = 'declined' THEN
    IF NOT agency_holds_role(NEW.decided_by, NEW.client_organization_id, ARRAY['owner']) THEN
      RAISE EXCEPTION 'Only an owner of the business can decline agency access.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.decided_at := now();
  ELSIF NEW.status = 'revoked' AND OLD.status IN ('requested', 'active') THEN
    -- Ended by the client (owner or manager), or withdrawn by the agency
    -- (owner or manager). Ending access is never a widening of it.
    IF NOT (agency_holds_role(NEW.revoked_by, NEW.client_organization_id, ARRAY['owner','manager'])
            OR agency_holds_role(NEW.revoked_by, NEW.agency_organization_id, ARRAY['owner','manager'])) THEN
      RAISE EXCEPTION 'Only the business or the agency can end agency access.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.revoked_at := now();
    IF NEW.role <> OLD.role OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'Ending access changes nothing else.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = OLD.status AND OLD.status = 'active' THEN
    -- In force: the only change is to end it sooner.
    IF NEW.role <> OLD.role OR NEW.decided_by <> OLD.decided_by OR NEW.decided_at <> OLD.decided_at
       OR NEW.revoked_by IS NOT NULL OR NEW.revoked_at IS NOT NULL
       OR NEW.expires_at > OLD.expires_at THEN
      RAISE EXCEPTION 'Agency access in force can only be shortened or ended.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = OLD.status AND OLD.status = 'requested' THEN
    IF ROW(NEW.role, NEW.decided_by, NEW.decided_at, NEW.expires_at, NEW.revoked_by, NEW.revoked_at)
       IS DISTINCT FROM ROW(OLD.role, OLD.decided_by, OLD.decided_at, OLD.expires_at, OLD.revoked_by, OLD.revoked_at) THEN
      RAISE EXCEPTION 'A request changes only by being decided.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'Agency access cannot go from % to %.', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS agency_grants_rules ON agency_grants;--> statement-breakpoint
CREATE TRIGGER agency_grants_rules
  BEFORE INSERT OR UPDATE ON agency_grants
  FOR EACH ROW EXECUTE FUNCTION agency_grants_rules();--> statement-breakpoint

CREATE OR REPLACE FUNCTION agency_grant_people_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  g agency_grants%ROWTYPE;
BEGIN
  SELECT * INTO g FROM agency_grants WHERE id = NEW.grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such grant.' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The agency names one of its own people; the client decides.
    IF NEW.status <> 'requested' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'A person starts as a request the business approves.' USING ERRCODE = 'check_violation';
    END IF;
    IF g.status NOT IN ('requested', 'active') THEN
      RAISE EXCEPTION 'People can only be added to an open grant.' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT agency_holds_role(NEW.added_by, g.agency_organization_id, ARRAY['owner','manager']) THEN
      RAISE EXCEPTION 'Only an owner or manager of the agency can name its people.' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT agency_holds_role(NEW.user_id, g.agency_organization_id,
                             ARRAY['owner','manager','editor','publisher','asset_manager','viewer']) THEN
      RAISE EXCEPTION 'Only a member of the agency can be named on its grant.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.added_at := now();
    RETURN NEW;
  END IF;

  IF NEW.grant_id <> OLD.grant_id OR NEW.user_id <> OLD.user_id
     OR NEW.added_by <> OLD.added_by OR NEW.added_at <> OLD.added_at THEN
    RAISE EXCEPTION 'Who was named, and by whom, cannot be rewritten.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('declined', 'removed') THEN
    RAISE EXCEPTION 'A declined or removed person is closed; name them again on a new grant.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'Nothing to decide.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'approved' AND OLD.status IN ('requested', 'blocked') THEN
    -- Approving a person, or unblocking them, is the client owner's.
    IF NOT agency_holds_role(NEW.decided_by, g.client_organization_id, ARRAY['owner']) THEN
      RAISE EXCEPTION 'Only an owner of the business can approve an agency person.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status IN ('declined', 'blocked') AND OLD.status IN ('requested', 'approved') THEN
    IF NEW.status = 'declined' AND OLD.status <> 'requested' THEN
      RAISE EXCEPTION 'Only a request can be declined; block an approved person.' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT agency_holds_role(NEW.decided_by, g.client_organization_id, ARRAY['owner','manager']) THEN
      RAISE EXCEPTION 'Only the business can decline or block an agency person.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'removed' AND OLD.status IN ('requested', 'approved', 'blocked') THEN
    -- The agency takes its own person off, or the person steps off.
    IF NOT (NEW.decided_by = OLD.user_id
            OR agency_holds_role(NEW.decided_by, g.agency_organization_id, ARRAY['owner','manager'])) THEN
      RAISE EXCEPTION 'Only the agency or the person can take them off a grant.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'An agency person cannot go from % to %.', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS agency_grant_people_rules ON agency_grant_people;--> statement-breakpoint
CREATE TRIGGER agency_grant_people_rules
  BEFORE INSERT OR UPDATE ON agency_grant_people
  FOR EACH ROW EXECUTE FUNCTION agency_grant_people_rules();--> statement-breakpoint

REVOKE ALL ON FUNCTION agency_grants_rules(), agency_grant_people_rules(),
  organizations_agency_flag_guard() FROM PUBLIC;--> statement-breakpoint

-- History is kept: no DELETE for the application.
GRANT SELECT, INSERT, UPDATE ON agency_grants, agency_grant_people TO portal_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- When a sign-in last passed the authenticator, for the portal's freshness
-- rules (24 hours to use agency access; 5 minutes to decide on it). Same
-- liveness as auth_session_touch; NULL for anything not live.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_session_verified_at(p_session_id text)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT mfa_verified_at FROM auth_sessions
   WHERE id = p_session_id
     AND expires_at > now()
     AND created_at > now() - interval '7 days'
     AND last_active_at > now() - interval '48 hours';
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_session_verified_at(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_session_verified_at(text) TO portal_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- audit_events: append-only, one business's rows visible only to it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  actor_user_id uuid REFERENCES users(id),
  agency_grant_id uuid REFERENCES agency_grants(id),
  action text NOT NULL,
  target text,
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_events_org_idx ON audit_events (organization_id, created_at DESC);--> statement-breakpoint

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS audit_events_tenant_isolation ON audit_events;--> statement-breakpoint
CREATE POLICY audit_events_tenant_isolation ON audit_events
  FOR ALL TO portal_app
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT ON audit_events TO portal_app;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE audit_events_id_seq TO portal_app;
