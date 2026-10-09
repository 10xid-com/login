-- 0034 — SOCIAL CONNECTIONS: a business's Instagram account, and the photos
-- it is about to post.
--
-- The Instagram channel (app.10xid.com/channels/instagram) connects one
-- Instagram professional account to a business through Instagram's own sign-in
-- (Instagram API with Instagram Login), posts photos and carousels to it, and
-- shows how recent posts did.
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
-- social_media. Instagram does not take an upload: it fetches each photo from
-- a public address the moment a post is made. The portal keeps the photo here
-- until then, and serves it at an address that holds a random token. Only the
-- token's sha-256 is stored, and only social_media_public() can read a photo
-- without a business scope. Rows last 24 hours and are deleted once posted.
--
-- Two functions run without a business scope, and do one thing each:
--   social_media_public(hash)        the photo behind a token, while it lasts
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
	"token_hash" text NOT NULL UNIQUE,
	"content_type" text NOT NULL,
	"bytes" bytea NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	-- Instagram takes JPEG and nothing else; the editor converts before upload.
	CONSTRAINT "social_media_jpeg" CHECK ("content_type" = 'image/jpeg'),
	CONSTRAINT "social_media_size" CHECK (octet_length("bytes") BETWEEN 1 AND 8388608),
	CONSTRAINT "social_media_hash" CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_media_expires_idx" ON "social_media" ("expires_at");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON social_connections TO portal_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON social_media TO portal_app;--> statement-breakpoint

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

-- The photo behind a token, for Instagram's fetch: no business scope, nothing
-- but the type and bytes of one unexpired photo whose token hashes to this.
CREATE OR REPLACE FUNCTION social_media_public(p_token_hash text)
RETURNS TABLE (content_type text, bytes bytea)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT m.content_type, m.bytes
    FROM social_media m
   WHERE m.token_hash = p_token_hash
     AND m.expires_at > now();
$$;--> statement-breakpoint

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

REVOKE ALL ON FUNCTION social_media_public(text), social_connection_revoke(text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION social_media_public(text), social_connection_revoke(text, text, text) TO portal_app;
