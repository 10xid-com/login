-- 0026: renewing agency access, and remembering expiry reminders.
--
-- Renewal. Access in force can only be shortened or ended (0025), so the only
-- way to continue is to ask again: a new request the business's owner
-- approves, and every person on it approved again by the owner. Nothing
-- renews by itself, and nothing is carried over without the owner's say.
--
-- 0025 counted an expired grant as still open (its status stays 'active', the
-- clock is what ends it), so once access ran out the agency could never ask
-- again. Now:
--   * one WAITING request per business and agency (the unique index keeps its
--     name, so the portal's handling of it is unchanged);
--   * a request is refused while that pair has access in force for more than
--     seven more days: renewal opens in the last seven days, and stays open
--     after the end;
--   * the request records the grant it renews (renews_grant_id), set here and
--     never by the portal.
-- An approved renewal runs from its approval. The grant it renews keeps its
-- own end date, so people already approved keep working until then while the
-- owner approves them again on the renewal.
--
-- Reminders. agency_grant_reminders remembers each reminder: one row per
-- grant, recipient and kind (the unique constraint), so however often the
-- reminder run is started, and however many run at once, a person is told
-- once. The run claims the row before it sends ('sending'), then records
-- 'sent' or 'failed'. Only 'failed' is tried again, at most five times; a
-- row left 'sending' (the run died mid-send) is never retried, because the
-- message may have gone.

DROP INDEX IF EXISTS agency_grants_one_open_idx;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agency_grants_one_open_idx
  ON agency_grants (client_organization_id, agency_organization_id)
  WHERE status = 'requested';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agency_grants_pair_active_idx
  ON agency_grants (client_organization_id, agency_organization_id, expires_at)
  WHERE status = 'active';--> statement-breakpoint

ALTER TABLE agency_grants ADD COLUMN IF NOT EXISTS renews_grant_id uuid REFERENCES agency_grants(id);--> statement-breakpoint

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
    -- Renewal opens in the last seven days of access in force, and stays
    -- open once it has ended. Until then there is nothing to ask for.
    IF EXISTS (SELECT 1 FROM agency_grants g
                WHERE g.client_organization_id = NEW.client_organization_id
                  AND g.agency_organization_id = NEW.agency_organization_id
                  AND g.status = 'active'
                  AND g.expires_at > now() + interval '7 days') THEN
      RAISE EXCEPTION 'Access is already in force; it can be renewed in its last seven days.'
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'agency_grants_one_open_idx';
    END IF;
    -- What it renews is the database's to say, never the portal's.
    NEW.renews_grant_id := (
      SELECT g.id FROM agency_grants g
       WHERE g.client_organization_id = NEW.client_organization_id
         AND g.agency_organization_id = NEW.agency_organization_id
         AND g.status = 'active'
       ORDER BY g.expires_at DESC
       LIMIT 1);
    NEW.requested_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE. What was asked for, by whom, and for how long never changes.
  IF NEW.client_organization_id <> OLD.client_organization_id
     OR NEW.agency_organization_id <> OLD.agency_organization_id
     OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at
     OR NEW.reason <> OLD.reason OR NEW.duration_days <> OLD.duration_days
     OR NEW.renews_grant_id IS DISTINCT FROM OLD.renews_grant_id THEN
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
$$;--> statement-breakpoint--> statement-breakpoint

REVOKE ALL ON FUNCTION agency_grants_rules() FROM PUBLIC;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS agency_grant_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES agency_grants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL DEFAULT 'expiry_7d',
  status text NOT NULL DEFAULT 'sending',
  attempts integer NOT NULL DEFAULT 1,
  last_error text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT agency_grant_reminders_kind CHECK (kind IN ('expiry_7d')),
  CONSTRAINT agency_grant_reminders_status CHECK (status IN ('sending', 'sent', 'failed')),
  CONSTRAINT agency_grant_reminders_attempts CHECK (attempts BETWEEN 1 AND 5),
  CONSTRAINT agency_grant_reminders_sent_at CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT agency_grant_reminders_error_length CHECK (last_error IS NULL OR length(last_error) <= 500),
  CONSTRAINT agency_grant_reminders_once UNIQUE (grant_id, user_id, kind)
);--> statement-breakpoint

-- A reminder starts as a claim; 'sent' is final; only a failure is retried,
-- and each retry counts. Which grant, whom and what never change.
CREATE OR REPLACE FUNCTION agency_grant_reminders_rules()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'sending' OR NEW.attempts <> 1 OR NEW.sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'A reminder starts as a claim.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.claimed_at := now();
    RETURN NEW;
  END IF;
  IF NEW.grant_id <> OLD.grant_id OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'A reminder cannot be rewritten.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'sent' THEN
    RAISE EXCEPTION 'A sent reminder is final.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'sending' AND NEW.status IN ('sent', 'failed') AND NEW.attempts = OLD.attempts THEN
    IF NEW.status = 'sent' THEN NEW.sent_at := now(); END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'failed' AND NEW.status = 'sending' AND NEW.attempts = OLD.attempts + 1 THEN
    NEW.claimed_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A reminder cannot go from % to %.', OLD.status, NEW.status USING ERRCODE = 'check_violation';
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS agency_grant_reminders_rules ON agency_grant_reminders;--> statement-breakpoint
CREATE TRIGGER agency_grant_reminders_rules
  BEFORE INSERT OR UPDATE ON agency_grant_reminders
  FOR EACH ROW EXECUTE FUNCTION agency_grant_reminders_rules();--> statement-breakpoint

REVOKE ALL ON FUNCTION agency_grant_reminders_rules() FROM PUBLIC;--> statement-breakpoint

-- Kept, like the grants: no DELETE for the application.
GRANT SELECT, INSERT, UPDATE ON agency_grant_reminders TO portal_app;
