-- 0033: what kind of work a job is — a quote, an estimate, or a job.
--
-- Paolo's ask of 2026-10-09: Vinyl Wrap Toronto's website forms land in Jobs
-- labelled by what they are. The Limited Time Offer form is an estimate; every
-- other form is a request for a quote. Work raised in the portal is chosen on
-- the form, and defaults to a job. A quote or an estimate that the customer
-- accepts becomes a job by changing this, which the portal records in the
-- job's history like any other change.
--
-- One column with a default, so every existing row is a job and nothing that
-- writes `jobs` without naming it changes. Ordered by how work progresses:
-- asked to price, priced, doing.
--
-- Re-runnable: every statement is guarded.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_kind') THEN
    CREATE TYPE job_kind AS ENUM ('quote', 'estimate', 'job');
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kind job_kind NOT NULL DEFAULT 'job';
