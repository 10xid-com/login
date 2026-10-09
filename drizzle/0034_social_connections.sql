-- 0034 — SOCIAL CONNECTIONS: a business's Instagram account, and the photos
-- and videos it is about to post.
--
-- The Instagram channel (app.10xid.com/channels/instagram) connects one
-- Instagram professional account to a business through Instagram's own sign-in
-- (Instagram API with Instagram Login), posts photos, Reels and carousels to
-- it, and shows how recent posts did.
--
-- social_connections. Unlike site_connections (0028), this one holds a secret:
-- the account's long-lived access token, which Instagram issues for 60 days and
-- the portal refreshes. It is stored ENCRYPTED by the app (AES-256-GCM, key in
-- CHANNEL_TOKEN_KEY on the app service), so the database alone does not hold a
-- usable token. On disconnect the ciphertext is erased with the timestamp, so a
-- past connection keeps its history and no longer holds anything.
--
--   - one live connection per business per channel;
--   - one live connection per Instagram account across every business, so two
--     businesses can never both post as the same account (the unique index is
--     not filtered by row-level security, which is the point).
--
-- social_media. Instagram does not take an upload: it fetches each photo and
-- video from an address the moment a post is made. The files wait in the
-- app's private object store (a Railway bucket) until then, and Instagram is
-- handed a presigned address for each. This table records which business each
-- file belongs to, so one business can never post another's: the file's key,
-- its kind and size, and, for a video still arriving in parts, the store's
-- upload id. Rows last 24 hours and go, with their files, once posted.
--
-- One function runs without a business scope:
--   social_connection_revoke(...)    Instagram's notice that the person
--                                    removed the app (deauthorize / data
--                                    deletion): disconnect and erase the token
--
-- Re-runnable: every statement is guarded.

CREATE TABLE IF NOT EXISTS "social_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
	"channel" text NOT NULL,
	-- The Instagram professional account id: what posts are made to.
	"account_id" text NOT NULL,
	-- The app-scoped id Instagram's sign-in and its notices name the person by.
	"scoped_id" text NOT NULL,
	"username" text NOT NULL,
	"token_ciphertext" text,
	"token_expires_at" timestamp with time zone,
	"token_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"connected_by" uuid NOT NULL REFERENCES "users"("id"),
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "social_connections_channel_known" CHECK ("channel" IN ('instagram')),
	-- Live means it holds a token; disconnected means it holds none.
	CONSTRAINT "social_connections_token_iff_live" CHECK (("disconnected_at" IS NULL) = ("token_ciphertext" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "social_connections_live_channel_idx"
  ON "social_connections" ("organization_id", "channel") WHERE "disconnected_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "social_connections_live_account_idx"
  ON "social_connections" ("channel", "account_id") WHERE "disconnected_at" IS NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "social_media" (
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
	CONSTRAINT "social_media_kind" CHECK (
		("kind" = 'photo' AND "content_type" = 'image/jpeg' AND "byte_size" BETWEEN 1 AND 8388608)
		OR ("kind" = 'video' AND "content_type" IN ('video/mp4', 'video/quicktime') AND "byte_size" BETWEEN 1 AND 314572800)
	),
	CONSTRAINT "social_media_key" CHECK ("storage_key" ~ '^social/[0-9a-f-]{36}/[A-Za-z0-9_-]{22,64}\.(jpg|mp4|mov)$'),
	-- Whole means no upload is open.
	CONSTRAINT "social_media_ready_whole" CHECK (NOT "ready" OR "upload_id" IS NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_media_expires_idx" ON "social_media" ("expires_at");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON social_connections TO portal_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON social_media TO portal_app;--> statement-breakpoint

ALTER TABLE social_connections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE social_media ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS social_connections_tenant_isolation ON social_connections;--> statement-breakpoint
CREATE POLICY social_connections_tenant_isolation ON social_connections
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS social_media_tenant_isolation ON social_media;--> statement-breakpoint
CREATE POLICY social_media_tenant_isolation ON social_media
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- Instagram says the person removed the app, or asked for their data to be
-- deleted. The notice names them by an id Instagram issued to this app (the
-- sign-in's, or the account's: either is matched); it is checked
-- (signed with the app secret) by the portal before this is called. Every
-- live connection to that account is disconnected and its token erased, and
-- the business's record says so. Returns how many were.
CREATE OR REPLACE FUNCTION social_connection_revoke(p_channel text, p_scoped_id text, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  IF p_channel <> 'instagram' OR p_reason NOT IN ('deauthorize', 'deletion_request') THEN
    RAISE EXCEPTION 'social_connection_revoke: unknown channel or reason';
  END IF;
  FOR r IN
    UPDATE social_connections
       SET disconnected_at = now(), token_ciphertext = NULL, token_expires_at = NULL
     WHERE channel = p_channel
       AND (scoped_id = p_scoped_id OR account_id = p_scoped_id)
       AND disconnected_at IS NULL
    RETURNING organization_id, username
  LOOP
    INSERT INTO audit_events (organization_id, actor_user_id, action, target)
    VALUES (r.organization_id, NULL, p_channel || '.disconnected_by_' || p_reason, '@' || r.username);
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION social_connection_revoke(text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION social_connection_revoke(text, text, text) TO portal_app;
