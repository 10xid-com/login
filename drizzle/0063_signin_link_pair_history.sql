-- A pair that has EVER held a verified sign-in link (active or revoked) must
-- never fall back to the legacy, unverified Rana compatibility. Otherwise
-- revoking an explicit link would silently bring the old display back.
-- Read-only; reveals only whether the caller's own account has history with a
-- named partner, and grants nothing.
CREATE OR REPLACE FUNCTION signin_link_pair_history(p_user uuid, p_other uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM signin_links l
                  WHERE l.user_low = LEAST(p_user, p_other) AND l.user_high = GREATEST(p_user, p_other));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION signin_link_pair_history(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION signin_link_pair_history(uuid, uuid) TO portal_app;
