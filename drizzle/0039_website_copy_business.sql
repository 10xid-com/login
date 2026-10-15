-- 0039 — THE WEBSITE COPY, BY NAME: a `business` column on every site_* table.
--
-- Paolo's ask of 2026-10-15: each row of the website copy (0038) says, by
-- name, which business its content comes from, so the tables read plainly in
-- a database viewer. organization_id stays the reference; `business` is the
-- business's name beside it.
--
-- It is filled by the database, never by the application: a BEFORE INSERT OR
-- UPDATE trigger (on every update, so it cannot be overwritten either) copies
-- organizations.name for the row's organization_id, so
-- every row has it however it is written, and a client cannot put another
-- business's name on its own rows. The function is SECURITY DEFINER because
-- the application's role need not read organizations to write a copy; it
-- reads one name, for the row's own organization_id, and nothing else.
--
-- Existing rows are filled now. A business renamed later shows its new name
-- on the next copy, which replaces every row (every 10 minutes).
--
-- Additive and re-runnable: every statement is guarded.
CREATE OR REPLACE FUNCTION site_copy_business_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  SELECT o.name INTO NEW.business FROM organizations o WHERE o.id = NEW.organization_id;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION site_copy_business_name() FROM PUBLIC;--> statement-breakpoint
ALTER TABLE site_copies ADD COLUMN IF NOT EXISTS "business" text;--> statement-breakpoint
DROP TRIGGER IF EXISTS site_copies_business ON site_copies;--> statement-breakpoint
CREATE TRIGGER site_copies_business BEFORE INSERT OR UPDATE ON site_copies
  FOR EACH ROW EXECUTE FUNCTION site_copy_business_name();--> statement-breakpoint
UPDATE site_copies c SET business = o.name FROM organizations o WHERE o.id = c.organization_id AND c.business IS DISTINCT FROM o.name;--> statement-breakpoint
ALTER TABLE site_jobs ADD COLUMN IF NOT EXISTS "business" text;--> statement-breakpoint
DROP TRIGGER IF EXISTS site_jobs_business ON site_jobs;--> statement-breakpoint
CREATE TRIGGER site_jobs_business BEFORE INSERT OR UPDATE ON site_jobs
  FOR EACH ROW EXECUTE FUNCTION site_copy_business_name();--> statement-breakpoint
UPDATE site_jobs c SET business = o.name FROM organizations o WHERE o.id = c.organization_id AND c.business IS DISTINCT FROM o.name;--> statement-breakpoint
ALTER TABLE site_clients ADD COLUMN IF NOT EXISTS "business" text;--> statement-breakpoint
DROP TRIGGER IF EXISTS site_clients_business ON site_clients;--> statement-breakpoint
CREATE TRIGGER site_clients_business BEFORE INSERT OR UPDATE ON site_clients
  FOR EACH ROW EXECUTE FUNCTION site_copy_business_name();--> statement-breakpoint
UPDATE site_clients c SET business = o.name FROM organizations o WHERE o.id = c.organization_id AND c.business IS DISTINCT FROM o.name;--> statement-breakpoint
ALTER TABLE site_materials ADD COLUMN IF NOT EXISTS "business" text;--> statement-breakpoint
DROP TRIGGER IF EXISTS site_materials_business ON site_materials;--> statement-breakpoint
CREATE TRIGGER site_materials_business BEFORE INSERT OR UPDATE ON site_materials
  FOR EACH ROW EXECUTE FUNCTION site_copy_business_name();--> statement-breakpoint
UPDATE site_materials c SET business = o.name FROM organizations o WHERE o.id = c.organization_id AND c.business IS DISTINCT FROM o.name;--> statement-breakpoint
ALTER TABLE site_stock_moves ADD COLUMN IF NOT EXISTS "business" text;--> statement-breakpoint
DROP TRIGGER IF EXISTS site_stock_moves_business ON site_stock_moves;--> statement-breakpoint
CREATE TRIGGER site_stock_moves_business BEFORE INSERT OR UPDATE ON site_stock_moves
  FOR EACH ROW EXECUTE FUNCTION site_copy_business_name();--> statement-breakpoint
UPDATE site_stock_moves c SET business = o.name FROM organizations o WHERE o.id = c.organization_id AND c.business IS DISTINCT FROM o.name;--> statement-breakpoint
ALTER TABLE site_posts ADD COLUMN IF NOT EXISTS "business" text;--> statement-breakpoint
DROP TRIGGER IF EXISTS site_posts_business ON site_posts;--> statement-breakpoint
CREATE TRIGGER site_posts_business BEFORE INSERT OR UPDATE ON site_posts
  FOR EACH ROW EXECUTE FUNCTION site_copy_business_name();--> statement-breakpoint
UPDATE site_posts c SET business = o.name FROM organizations o WHERE o.id = c.organization_id AND c.business IS DISTINCT FROM o.name;--> statement-breakpoint
ALTER TABLE site_social_posts ADD COLUMN IF NOT EXISTS "business" text;--> statement-breakpoint
DROP TRIGGER IF EXISTS site_social_posts_business ON site_social_posts;--> statement-breakpoint
CREATE TRIGGER site_social_posts_business BEFORE INSERT OR UPDATE ON site_social_posts
  FOR EACH ROW EXECUTE FUNCTION site_copy_business_name();--> statement-breakpoint
UPDATE site_social_posts c SET business = o.name FROM organizations o WHERE o.id = c.organization_id AND c.business IS DISTINCT FROM o.name;--> statement-breakpoint
ALTER TABLE site_social_profiles ADD COLUMN IF NOT EXISTS "business" text;--> statement-breakpoint
DROP TRIGGER IF EXISTS site_social_profiles_business ON site_social_profiles;--> statement-breakpoint
CREATE TRIGGER site_social_profiles_business BEFORE INSERT OR UPDATE ON site_social_profiles
  FOR EACH ROW EXECUTE FUNCTION site_copy_business_name();--> statement-breakpoint
UPDATE site_social_profiles c SET business = o.name FROM organizations o WHERE o.id = c.organization_id AND c.business IS DISTINCT FROM o.name;
