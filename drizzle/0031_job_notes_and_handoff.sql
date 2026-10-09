-- 0031: notes on a job, and handing a job to a teammate.
--
-- Paolo's ask of 2026-10-09: the people of one business pass work to each
-- other. A job already has `assigned_to`; nothing could set it, and there was
-- nowhere to say anything about the work. This adds the second half and puts
-- a rule on the first.
--
-- job_notes is the conversation on a job. Append-only, like job_events: the
-- application role holds SELECT and INSERT and nothing else, so what somebody
-- wrote when they handed a job over cannot be edited afterwards to match what
-- happened next. A note that went with a handover names who it was handed to
-- (`handed_to`); the handover itself is a job_events row, as every other
-- change to a job is.
--
-- Isolated exactly like job_events: the client's policy, and the staff
-- survey policy beside it. A note carries organization_id directly, and a
-- trigger refuses one whose job belongs to somebody else — the FOREIGN KEY
-- check runs as the owner and ignores row-level security, so without it a
-- note could point at another business's job by id.
--
-- Handing over is setting jobs.assigned_to, and it may only name a person of
-- that job's business: a live, real (not service) account with a membership.
-- Checked only when the value changes, so rows written before this migration
-- are left as they are.
--
-- Re-runnable: every statement is guarded.

CREATE TABLE IF NOT EXISTS job_notes (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  author_id uuid NOT NULL REFERENCES users(id),
  author_email_at_time text NOT NULL,
  body text NOT NULL,
  handed_to uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_notes_body_sane CHECK (length(btrim(body)) BETWEEN 1 AND 4000)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS job_notes_job_idx ON job_notes (job_id, created_at);--> statement-breakpoint

-- Is this a person of this business who can be given work?
CREATE OR REPLACE FUNCTION job_assignable(p_user uuid, p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM memberships m
      JOIN users u ON u.id = m.user_id
     WHERE m.user_id = p_user
       AND m.organization_id = p_org
       AND u.deleted_at IS NULL
       AND NOT u.is_service
  );
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION job_assignable(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION job_assignable(uuid, uuid) TO portal_app;--> statement-breakpoint

-- A note belongs to its job's business, says when it was written by the
-- server's clock, and hands over only to somebody of that business.
-- SECURITY INVOKER on purpose: the job is read under the caller's row-level
-- security, so a job of another business is simply not found.
CREATE OR REPLACE FUNCTION job_notes_rules()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM jobs WHERE id = NEW.job_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'job % does not exist', NEW.job_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := v_org;
  ELSIF NEW.organization_id <> v_org THEN
    RAISE EXCEPTION 'A note names business % but its job belongs to business %',
      NEW.organization_id, v_org
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.handed_to IS NOT NULL AND NOT job_assignable(NEW.handed_to, v_org) THEN
    RAISE EXCEPTION 'A job can only be handed to a person of its business.'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION job_notes_rules() FROM PUBLIC;--> statement-breakpoint

DROP TRIGGER IF EXISTS job_notes_rules ON job_notes;--> statement-breakpoint
CREATE TRIGGER job_notes_rules
  BEFORE INSERT ON job_notes
  FOR EACH ROW EXECUTE FUNCTION job_notes_rules();--> statement-breakpoint

CREATE OR REPLACE FUNCTION jobs_assignee_rules()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.assigned_to IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to)
     AND NOT job_assignable(NEW.assigned_to, NEW.organization_id) THEN
    RAISE EXCEPTION 'A job can only be handed to a person of its business.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION jobs_assignee_rules() FROM PUBLIC;--> statement-breakpoint

DROP TRIGGER IF EXISTS jobs_assignee_rules ON jobs;--> statement-breakpoint
CREATE TRIGGER jobs_assignee_rules
  BEFORE INSERT OR UPDATE OF assigned_to ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_assignee_rules();--> statement-breakpoint

-- Kept: no UPDATE or DELETE for the application.
GRANT SELECT, INSERT ON job_notes TO portal_app;--> statement-breakpoint

ALTER TABLE job_notes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS job_notes_tenant_isolation ON job_notes;--> statement-breakpoint
CREATE POLICY job_notes_tenant_isolation ON job_notes
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS job_notes_staff_read ON job_notes;--> statement-breakpoint
CREATE POLICY job_notes_staff_read ON job_notes
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');
