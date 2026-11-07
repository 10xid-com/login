-- A Work Deck roster uses the name shown on the member's private PiD page.
-- Allow the full human roster only where the CiD directory is visible.
-- Use the relation names available both before and after the CiD table rename.
CREATE FUNCTION public.work_deck_pid_names()
RETURNS TABLE (user_id uuid, display_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT member.id, nullif(btrim(profile.name), '')
    FROM public.memberships AS assignment
    JOIN public.organizations AS company ON company.id = assignment.organization_id
    JOIN public.users AS member ON member.id = assignment.user_id
    LEFT JOIN public.auth_users AS profile ON profile.id = member.auth_user_id AND profile.email_verified
   WHERE company.id = nullif(current_setting('app.org_id', true), '')::uuid
     AND company.deleted_at IS NULL
     AND member.deleted_at IS NULL
     AND NOT member.is_service
     AND EXISTS (
       SELECT 1
         FROM public.memberships AS access
         JOIN public.users AS actor ON actor.id = access.user_id
        WHERE access.organization_id = company.id
          AND access.user_id = nullif(current_setting('app.user_id', true), '')::uuid
          AND access.role::text IN ('owner', 'admin', 'member')
          AND (
            assignment.role::text IN ('owner', 'admin', 'member')
            OR access.role::text IN ('owner', 'manager')
            OR company.member_visibility::text = 'open'
          )
          AND actor.deleted_at IS NULL
          AND NOT actor.is_service
     );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.work_deck_pid_names() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.work_deck_pid_names() TO portal_app;
