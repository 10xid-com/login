-- 0036: Facebook Pages beside Instagram in social_connections.
--
-- The Facebook channel (app.10xid.com/channels/facebook) connects one
-- Facebook Page per business through Facebook Login, and keeps the Page's own
-- access token, sealed by the app exactly as Instagram's is (0034). A Page
-- token does not expire, so token_expires_at stays NULL for these rows. For a
-- Facebook row:
--
--   account_id   the Page's id: what posts are made to
--   scoped_id    the app-scoped id of the person who connected it, which is
--                what Meta's deauthorize and data-deletion notices name
--   username     the Page's name
--
-- 0034's two unique indexes hold unchanged: one live Page per business, and
-- one business per Page.
--
-- social_connection_revoke() is replaced to accept the Facebook channel's
-- notices too, and to record a Page by its name rather than as @username.
--
-- Additive and re-runnable: the check is widened, the function replaced.

ALTER TABLE social_connections DROP CONSTRAINT IF EXISTS social_connections_channel_known;--> statement-breakpoint
ALTER TABLE social_connections ADD CONSTRAINT social_connections_channel_known CHECK ("channel" IN ('instagram', 'facebook'));--> statement-breakpoint

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
  IF p_channel NOT IN ('instagram', 'facebook') OR p_reason NOT IN ('deauthorize', 'deletion_request') THEN
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
    VALUES (
      r.organization_id,
      NULL,
      p_channel || '.disconnected_by_' || p_reason,
      CASE WHEN p_channel = 'instagram' THEN '@' || r.username ELSE r.username END
    );
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION social_connection_revoke(text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION social_connection_revoke(text, text, text) TO portal_app;
