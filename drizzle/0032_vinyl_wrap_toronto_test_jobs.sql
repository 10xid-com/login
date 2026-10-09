-- 0032: three test jobs in Vinyl Wrap Toronto, to try handing work over.
--
-- WHY. 0031 lets the people of a business hand a job to each other with a
-- note. Paolo's ask of 2026-10-09: some jobs in Vinyl Wrap Toronto to send
-- to somebody and see it work end to end.
--
-- WHAT IT DOES. Adds three open jobs, coming in from the client, each titled
-- "TEST: …" so they are plain to see and to archive afterwards:
--   - TEST: Full wrap – 2022 Ford Transit
--   - TEST: Window perf – storefront
--   - TEST: Logo decals – 2 vans
-- Each gets the next VIN-#### reference exactly as the portal allocates one
-- (the business's job counter, the slug's first three letters), is raised by
-- paolo@tboxstudio.com (an owner, 0029), and is assigned to nobody. Each has
-- its `created` history row, with no actor: written by migration, not by a
-- person in the portal, and the history says so.
--
-- IDEMPOTENT. A job is skipped when the business already has one with that
-- exact title, so a second run writes nothing. No business or no account on
-- the address: skipped, never raised, so the deploy is never taken down over
-- test data.
--
-- THE LOG IS THE ONLY READ PATH. Notices reach the deploy log through the
-- `notice` listener in scripts/migrate.mjs.

DO $$
DECLARE
  v_org_id   uuid;
  v_slug     text;
  v_user_id  uuid;
  v_counter  integer;
  v_ref      text;
  v_job_id   uuid;
  v_title    text;
  v_days     integer;
  v_email    constant text := 'paolo@tboxstudio.com';
  v_jobs     constant text[] := ARRAY[
    'TEST: Full wrap – 2022 Ford Transit',
    'TEST: Window perf – storefront',
    'TEST: Logo decals – 2 vans'
  ];
BEGIN
  RAISE NOTICE '[vwt-test-jobs] ======== test jobs on vinyl-wrap-toronto ========';

  SELECT o.id, o.slug INTO v_org_id, v_slug
    FROM organizations o
   WHERE o.slug = 'vinyl-wrap-toronto' AND o.type = 'client' AND o.deleted_at IS NULL;
  IF v_org_id IS NULL THEN
    RAISE NOTICE '[vwt-test-jobs] SKIPPED — no live client company on the slug vinyl-wrap-toronto. Nothing written.';
    RETURN;
  END IF;

  SELECT u.id INTO v_user_id FROM users u WHERE lower(u.email) = v_email AND u.deleted_at IS NULL;
  IF v_user_id IS NULL THEN
    RAISE NOTICE '[vwt-test-jobs] SKIPPED — no live account on %. Nothing written.', v_email;
    RETURN;
  END IF;

  FOR i IN 1 .. array_length(v_jobs, 1) LOOP
    v_title := v_jobs[i];
    v_days  := 7 * i;

    IF EXISTS (SELECT 1 FROM jobs WHERE organization_id = v_org_id AND title = v_title) THEN
      RAISE NOTICE '[vwt-test-jobs] already present  %. Nothing written.', v_title;
      CONTINUE;
    END IF;

    -- The portal's allocation (lib/db/index.ts, nextJobRef): bump the
    -- counter and read it in one statement.
    UPDATE organizations SET job_counter = job_counter + 1
     WHERE id = v_org_id
    RETURNING job_counter INTO v_counter;
    v_ref := coalesce(nullif(upper(left(regexp_replace(v_slug, '[^a-zA-Z0-9]', '', 'g'), 3)), ''), 'JOB')
             || '-' || lpad(v_counter::text, 4, '0');

    v_job_id := gen_random_uuid();
    INSERT INTO jobs (id, organization_id, ref, direction, title, status, created_by, due_at)
    VALUES (v_job_id, v_org_id, v_ref, 'from_client', v_title, 'open', v_user_id, now() + make_interval(days => v_days));

    INSERT INTO job_events (job_id, organization_id, actor_id, actor_email_at_time, action, after)
    VALUES (v_job_id, v_org_id, NULL, 'migration 0032', 'created',
            jsonb_build_object('title', v_title, 'direction', 'from_client', 'status', 'open'));

    RAISE NOTICE '[vwt-test-jobs] CREATED  % %', v_ref, v_title;
  END LOOP;
END
$$;
