-- A Work Deck roster uses the name shown on the member's private PiD page.
-- Expose only display names for eligible members in the current CiD scope.
CREATE FUNCTION public.work_deck_pid_names()
RETURNS TABLE (user_id uuid, display_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT member.id, nullif(btrim(profile.name), '')
    FROM public."role" AS assignment
    JOIN public."CiD" AS company ON company.id = assignment.organization_id
    JOIN public.users AS member ON member.id = assignment.user_id
    JOIN public.auth_users AS profile ON profile.id = member.auth_user_id
   WHERE company.id = nullif(current_setting('app.org_id', true), '')::uuid
     AND company.deleted_at IS NULL
     AND assignment.role::text IN ('owner', 'admin', 'member')
     AND member.deleted_at IS NULL
     AND NOT member.is_service
     AND profile.email_verified
     AND EXISTS (
       SELECT 1
         FROM public."role" AS access
         JOIN public.users AS actor ON actor.id = access.user_id
        WHERE access.organization_id = company.id
          AND access.user_id = nullif(current_setting('app.user_id', true), '')::uuid
          AND access.role::text IN ('owner', 'admin', 'member')
          AND actor.deleted_at IS NULL
          AND NOT actor.is_service
     );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.work_deck_pid_names() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.work_deck_pid_names() TO portal_app;
