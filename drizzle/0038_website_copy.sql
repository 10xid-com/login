-- 0038 — THE WEBSITE COPY: a read-only copy of each business's website records.
--
-- Paolo's decision of 2026-10-15: a business's jobs, clients, stock, posts and
-- social posts are to be in the 10XiD database, with the business's WEBSITE
-- kept as the master copy for now ("B for now"; 10XiD as the master is the
-- later step). So 10XiD keeps a copy and never edits it: the app's scheduled
-- copy (app: /api/v1/cron/site-copy) fetches each live website connection's
-- signed export (the site's /api/10xid/export/) and REPLACES that business's
-- copy with it, and the portal shows it read-only.
--
-- One table per kind of record, every business in the same table, each row
-- belonging to one business and one website connection:
--
--   site_copies           the last copy of each connection: when the site made
--                         it, when it was copied, the last failure, counts
--   site_jobs             the shop's jobs (vehicle, service, status, client,
--                         whether it has been posted about)
--   site_clients          who the work is for, and whether they may be named
--   site_materials        vinyl and laminate
--   site_stock_moves      deliveries, material used on a job, count changes;
--                         what is on hand is their sum
--   site_posts            the posts written for the site (not imported pages)
--   site_social_posts     each post's social row: a slot per platform, linked
--                         to the post about the job or still the profile
--   site_social_profiles  the business's own profiles, from its site
--
-- Every record keeps the WEBSITE's own id (source_id) and the website's own
-- times as the site wrote them (text), because this is a copy of the site's
-- record, not a record of 10XiD's: nothing here is parsed into something the
-- site did not say. References between them are by those ids too (a job's
-- client_source_id is a site_clients.source_id on the same connection), and
-- are not foreign keys: a copy is replaced whole, never row by row.
--
-- Isolated like every other business table: the tenant policy on app.org_id,
-- and the staff read policy beside it. The copy writes each business inside
-- that business's own scope, so it cannot write into another's. A record's
-- connection must be the same business's: (site_connection_id,
-- organization_id) references site_connections (id, organization_id).
--
-- site_copy_targets() is the one read without a business scope: the live
-- website connections, for the scheduled copy, which acts for no one person.
-- It returns addresses and names, nothing else.
--
-- Additive: no existing row or column changes. Re-runnable: every statement
-- is guarded.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_connections_id_org_unique') THEN
    ALTER TABLE site_connections ADD CONSTRAINT site_connections_id_org_unique UNIQUE (id, organization_id);
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_copies" (
  "site_connection_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  -- The address the copy was made from, as connected then.
  "site_url" text NOT NULL,
  -- When the site made the export it sent.
  "generated_at" timestamp with time zone,
  -- The last successful copy, and the last attempt.
  "copied_at" timestamp with time zone,
  "tried_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Why the last attempt failed; NULL once one succeeds.
  "error" text,
  -- How many of each kind the last successful copy held.
  "counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
  PRIMARY KEY ("site_connection_id"),
  CONSTRAINT "site_copies_connection_same_org_fk" FOREIGN KEY ("site_connection_id", "organization_id")
    REFERENCES "site_connections" ("id", "organization_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_clients" (
  "site_connection_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "source_id" integer NOT NULL,
  "name" text NOT NULL,
  "business" text,
  "email" text,
  "phone" text,
  "handle" text,
  "may_feature" boolean DEFAULT true NOT NULL,
  "notes" text,
  "created_on_site" text,
  "updated_on_site" text,
  PRIMARY KEY ("site_connection_id", "source_id"),
  CONSTRAINT "site_clients_connection_same_org_fk" FOREIGN KEY ("site_connection_id", "organization_id")
    REFERENCES "site_connections" ("id", "organization_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_materials" (
  "site_connection_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "source_id" integer NOT NULL,
  -- vinyl | laminate; and for vinyl, colour | printable | ppf.
  "kind" text NOT NULL,
  "type" text,
  "brand" text NOT NULL,
  "product" text NOT NULL,
  "code" text,
  "colour" text,
  "finish" text,
  "width_in" numeric,
  -- ft | m | roll | sheet
  "unit" text NOT NULL,
  "reorder_at" numeric,
  "active" boolean DEFAULT true NOT NULL,
  "notes" text,
  "created_on_site" text,
  "updated_on_site" text,
  PRIMARY KEY ("site_connection_id", "source_id"),
  CONSTRAINT "site_materials_connection_same_org_fk" FOREIGN KEY ("site_connection_id", "organization_id")
    REFERENCES "site_connections" ("id", "organization_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_stock_moves" (
  "site_connection_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "source_id" integer NOT NULL,
  "material_source_id" integer NOT NULL,
  -- + received or counted up; - used on a job or counted down.
  "qty" numeric NOT NULL,
  -- received | used | adjusted
  "reason" text NOT NULL,
  "job_source_id" integer,
  "note" text,
  "created_by" text,
  "created_on_site" text,
  PRIMARY KEY ("site_connection_id", "source_id"),
  CONSTRAINT "site_stock_moves_connection_same_org_fk" FOREIGN KEY ("site_connection_id", "organization_id")
    REFERENCES "site_connections" ("id", "organization_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_jobs" (
  "site_connection_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "source_id" integer NOT NULL,
  "quote_source_id" integer,
  "customer_name" text NOT NULL,
  "email" text,
  "phone" text,
  "vehicle" text,
  "service" text,
  "description" text,
  -- booked | in_progress | ready | completed | cancelled
  "status" text NOT NULL,
  "start_date" text,
  "due_date" text,
  "price_cents" integer,
  "deposit_cents" integer,
  "assigned_to" text,
  "notes" text,
  "completed_at" text,
  "client_source_id" integer,
  -- Posted about: when, and the site post that did it; or no post needed.
  "posted_at" text,
  "post_source_id" integer,
  "post_skipped" boolean DEFAULT false NOT NULL,
  "created_on_site" text,
  "updated_on_site" text,
  PRIMARY KEY ("site_connection_id", "source_id"),
  CONSTRAINT "site_jobs_connection_same_org_fk" FOREIGN KEY ("site_connection_id", "organization_id")
    REFERENCES "site_connections" ("id", "organization_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_posts" (
  "site_connection_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "source_id" integer NOT NULL,
  -- post (a blog post) | project (a before & after project)
  "kind" text NOT NULL,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  -- draft | published | scheduled | archived
  "status" text NOT NULL,
  "url" text NOT NULL,
  "published_at" text,
  "updated_on_site" text,
  -- Only on the business's stage site, not its live one.
  "stage_only" boolean DEFAULT false NOT NULL,
  PRIMARY KEY ("site_connection_id", "source_id"),
  CONSTRAINT "site_posts_connection_same_org_fk" FOREIGN KEY ("site_connection_id", "organization_id")
    REFERENCES "site_connections" ("id", "organization_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_social_posts" (
  "site_connection_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "post_source_id" integer NOT NULL,
  -- Its place in the post's social row.
  "position" integer NOT NULL,
  -- instagram | facebook | tiktok | youtube | linkedin | x
  "channel" text NOT NULL,
  "url" text NOT NULL,
  -- true: the slot opens the platform's post about the job; false: still the profile.
  "linked" boolean NOT NULL,
  PRIMARY KEY ("site_connection_id", "post_source_id", "position"),
  CONSTRAINT "site_social_posts_connection_same_org_fk" FOREIGN KEY ("site_connection_id", "organization_id")
    REFERENCES "site_connections" ("id", "organization_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_social_profiles" (
  "site_connection_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "position" integer NOT NULL,
  "channel" text NOT NULL,
  "url" text NOT NULL,
  PRIMARY KEY ("site_connection_id", "position"),
  CONSTRAINT "site_social_profiles_connection_same_org_fk" FOREIGN KEY ("site_connection_id", "organization_id")
    REFERENCES "site_connections" ("id", "organization_id")
);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON site_copies TO portal_app;--> statement-breakpoint
ALTER TABLE site_copies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS site_copies_tenant_isolation ON site_copies;--> statement-breakpoint
CREATE POLICY site_copies_tenant_isolation ON site_copies
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS site_copies_staff_read ON site_copies;--> statement-breakpoint
CREATE POLICY site_copies_staff_read ON site_copies
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON site_clients TO portal_app;--> statement-breakpoint
ALTER TABLE site_clients ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS site_clients_tenant_isolation ON site_clients;--> statement-breakpoint
CREATE POLICY site_clients_tenant_isolation ON site_clients
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS site_clients_staff_read ON site_clients;--> statement-breakpoint
CREATE POLICY site_clients_staff_read ON site_clients
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON site_materials TO portal_app;--> statement-breakpoint
ALTER TABLE site_materials ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS site_materials_tenant_isolation ON site_materials;--> statement-breakpoint
CREATE POLICY site_materials_tenant_isolation ON site_materials
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS site_materials_staff_read ON site_materials;--> statement-breakpoint
CREATE POLICY site_materials_staff_read ON site_materials
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON site_stock_moves TO portal_app;--> statement-breakpoint
ALTER TABLE site_stock_moves ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS site_stock_moves_tenant_isolation ON site_stock_moves;--> statement-breakpoint
CREATE POLICY site_stock_moves_tenant_isolation ON site_stock_moves
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS site_stock_moves_staff_read ON site_stock_moves;--> statement-breakpoint
CREATE POLICY site_stock_moves_staff_read ON site_stock_moves
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON site_jobs TO portal_app;--> statement-breakpoint
ALTER TABLE site_jobs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS site_jobs_tenant_isolation ON site_jobs;--> statement-breakpoint
CREATE POLICY site_jobs_tenant_isolation ON site_jobs
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS site_jobs_staff_read ON site_jobs;--> statement-breakpoint
CREATE POLICY site_jobs_staff_read ON site_jobs
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON site_posts TO portal_app;--> statement-breakpoint
ALTER TABLE site_posts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS site_posts_tenant_isolation ON site_posts;--> statement-breakpoint
CREATE POLICY site_posts_tenant_isolation ON site_posts
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS site_posts_staff_read ON site_posts;--> statement-breakpoint
CREATE POLICY site_posts_staff_read ON site_posts
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON site_social_posts TO portal_app;--> statement-breakpoint
ALTER TABLE site_social_posts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS site_social_posts_tenant_isolation ON site_social_posts;--> statement-breakpoint
CREATE POLICY site_social_posts_tenant_isolation ON site_social_posts
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS site_social_posts_staff_read ON site_social_posts;--> statement-breakpoint
CREATE POLICY site_social_posts_staff_read ON site_social_posts
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON site_social_profiles TO portal_app;--> statement-breakpoint
ALTER TABLE site_social_profiles ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS site_social_profiles_tenant_isolation ON site_social_profiles;--> statement-breakpoint
CREATE POLICY site_social_profiles_tenant_isolation ON site_social_profiles
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS site_social_profiles_staff_read ON site_social_profiles;--> statement-breakpoint
CREATE POLICY site_social_profiles_staff_read ON site_social_profiles
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');--> statement-breakpoint
-- The live website connections, for the scheduled copy: the one read it makes
-- without a business scope. Addresses and names only.
CREATE OR REPLACE FUNCTION site_copy_targets()
RETURNS TABLE (organization_id uuid, site_connection_id uuid, site_url text, business text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.organization_id, s.id, s.site_url, o.name
    FROM site_connections s
    JOIN organizations o ON o.id = s.organization_id
   WHERE s.channel = 'website'
     AND s.disconnected_at IS NULL
     AND o.deleted_at IS NULL
   ORDER BY o.name;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION site_copy_targets() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION site_copy_targets() TO portal_app;
