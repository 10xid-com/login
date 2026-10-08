-- 0028 — SITE CONNECTIONS: which website a business runs from the portal.
--
-- The Website channel (app.10xid.com/channels/website) lets a business edit
-- and publish its own site: blog posts first, then pages. This table is the
-- link that says which site that is, the same way `repositories` says which
-- GitHub repository a business may read:
--
--   - a site is connected to ONE business at a time (unique on its address
--     among live connections), so one business can never publish to another's
--     site, even by connecting the same address;
--   - a business has at most one live website connection;
--   - the repository it is built from, when there is one, must be a repository
--     linked to the same business (referenced by id AND business).
--
-- No secret is stored here. The portal signs each request it sends to the site
-- with its own private key (an environment variable on the app service), and
-- the site checks the signature with the portal's public key. Nothing in this
-- table is worth stealing.
--
-- Disconnecting is a timestamp, not a delete: what was published through a
-- connection still says where it went.

CREATE TABLE "site_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel" text DEFAULT 'website' NOT NULL,
	"site_url" text NOT NULL,
	"repository_id" uuid,
	"connected_by" uuid NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "site_connections_channel_known" CHECK ("channel" IN ('website')),
	-- An https origin and nothing else: no path, query, credentials or trailing slash.
	CONSTRAINT "site_connections_url_is_origin" CHECK ("site_url" ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
);
--> statement-breakpoint
ALTER TABLE "site_connections" ADD CONSTRAINT "site_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_connections" ADD CONSTRAINT "site_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_connections" ADD CONSTRAINT "site_connections_repository_same_org_fk"
  FOREIGN KEY ("repository_id", "organization_id") REFERENCES "repositories" ("id", "organization_id");--> statement-breakpoint
-- ONE live connection per address, across every business. Not filtered by
-- row-level security, which is the point: a second business cannot connect a
-- site the first already holds, even though it cannot see the first's row.
CREATE UNIQUE INDEX "site_connections_live_url_idx" ON "site_connections" USING btree ("site_url") WHERE "disconnected_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "site_connections_live_channel_idx" ON "site_connections" USING btree ("organization_id", "channel") WHERE "disconnected_at" IS NULL;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON site_connections TO portal_app;--> statement-breakpoint

ALTER TABLE site_connections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_connections_tenant_isolation ON site_connections
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
