-- 0035: private bucket-backed photo and video uploads.
-- 0034 is already deployed. Keep its photo table and public-fetch function
-- intact while the previous app release is still serving traffic. The new
-- app uses this separate table; no connected account or token is changed.
-- Legacy photos keep their original expiration and fetch behavior during
-- rollout. They cannot be mistaken for completed bucket-backed uploads.

CREATE TABLE IF NOT EXISTS "social_media_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
	"uploaded_by" uuid NOT NULL REFERENCES "users"("id"),
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	-- The object's key in the store. Made by the portal, never by a request.
	"storage_key" text NOT NULL UNIQUE,
	"byte_size" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	-- A video arriving in parts: the store's multipart upload id until it is whole.
	"upload_id" text,
	"ready" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	-- Instagram takes JPEG photos (the editor converts before upload) and MP4 or MOV video.
	CONSTRAINT "social_media_uploads_kind" CHECK (
		("kind" = 'photo' AND "content_type" = 'image/jpeg' AND "byte_size" BETWEEN 1 AND 8388608)
		OR ("kind" = 'video' AND "content_type" IN ('video/mp4', 'video/quicktime') AND "byte_size" BETWEEN 1 AND 314572800)
	),
	CONSTRAINT "social_media_uploads_key" CHECK ("storage_key" ~ '^social/[0-9a-f-]{36}/[A-Za-z0-9_-]{22,64}\.(jpg|mp4|mov)$'),
	-- Whole means no upload is open.
	CONSTRAINT "social_media_uploads_ready_whole" CHECK (NOT "ready" OR "upload_id" IS NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_media_uploads_expires_idx" ON "social_media_uploads" ("expires_at");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON social_media_uploads TO portal_app;--> statement-breakpoint
ALTER TABLE social_media_uploads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS social_media_uploads_tenant_isolation ON social_media_uploads;--> statement-breakpoint
CREATE POLICY social_media_uploads_tenant_isolation ON social_media_uploads
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
