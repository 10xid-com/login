-- 0040 — THE WEBSITE COPY COMES OUT.
--
-- Paolo's decision of 2026-10-16: Rana's iD only references a business's
-- data; it does not keep a copy of it. 0038 (the website copy) and 0039 (its
-- business column) are undone: the eight site_* tables, their two functions
-- and the unique constraint 0038 added to site_connections are dropped. Their
-- rows were only a copy of each website's own records, which the websites
-- still hold; nothing here is the only copy of anything.
--
-- The app's copy job and page were removed first (app#34), so nothing reads
-- or writes these tables when they go.
--
-- Re-runnable: every statement is guarded.
DROP TABLE IF EXISTS site_social_posts;--> statement-breakpoint
DROP TABLE IF EXISTS site_social_profiles;--> statement-breakpoint
DROP TABLE IF EXISTS site_posts;--> statement-breakpoint
DROP TABLE IF EXISTS site_stock_moves;--> statement-breakpoint
DROP TABLE IF EXISTS site_materials;--> statement-breakpoint
DROP TABLE IF EXISTS site_jobs;--> statement-breakpoint
DROP TABLE IF EXISTS site_clients;--> statement-breakpoint
DROP TABLE IF EXISTS site_copies;--> statement-breakpoint
DROP FUNCTION IF EXISTS site_copy_business_name();--> statement-breakpoint
DROP FUNCTION IF EXISTS site_copy_targets();--> statement-breakpoint
ALTER TABLE site_connections DROP CONSTRAINT IF EXISTS site_connections_id_org_unique;
