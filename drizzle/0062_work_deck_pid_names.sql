-- A Work Deck roster uses the name shown on the member's private PiD page.
-- Allow the full human roster only where the CiD directory is visible.
-- Use the relation names available both before and after the CiD table rename.
-- Bind the lookup to the application relations even on databases that moved
-- identity tables into domain schemas. Resolve identifiers once, as migration owner.
DO $migration$
DECLARE
  relation_name text;
  candidates text[];
  resolved text;
  relations text[] := ARRAY[]::text[];
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['memberships', 'organizations', 'users', 'auth_users'] LOOP
    SELECT array_agg(format('%I.%I', namespace.nspname, relation.relname)),
           min(format('%I.%I', namespace.nspname, relation.relname)) FILTER (
             WHERE relation.oid = to_regclass(quote_ident(relation_name))
           )
      INTO candidates, resolved
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE relation.relname = relation_name
       AND relation.relkind IN ('r', 'p', 'v')
       AND namespace.nspname !~ '^pg_'
       AND namespace.nspname <> 'information_schema'
       AND relation.relowner NOT IN ('portal_app'::regrole, 'portal_auth'::regrole);
    resolved := coalesce(resolved, CASE WHEN cardinality(candidates) = 1 THEN candidates[1] END);
    IF resolved IS NULL THEN
      RAISE EXCEPTION 'Could not resolve Work Deck roster relation %', relation_name;
    END IF;
    relations := array_append(relations, resolved);
  END LOOP;

  EXECUTE format($definition$
CREATE FUNCTION public.work_deck_pid_names()
RETURNS TABLE (user_id uuid, display_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $query$
  SELECT member.id, nullif(btrim(profile.name), '')
    FROM %1$s AS assignment
    JOIN %2$s AS company ON company.id = assignment.organization_id
    JOIN %3$s AS member ON member.id = assignment.user_id
    LEFT JOIN %4$s AS profile ON profile.id = member.auth_user_id AND profile.email_verified
   WHERE company.id = nullif(current_setting('app.org_id', true), '')::uuid
     AND company.deleted_at IS NULL
     AND member.deleted_at IS NULL
     AND NOT member.is_service
     AND EXISTS (
       SELECT 1
         FROM %1$s AS access
         JOIN %3$s AS actor ON actor.id = access.user_id
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
$query$;
  $definition$, VARIADIC relations);
END;
$migration$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.work_deck_pid_names() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.work_deck_pid_names() TO portal_app;
