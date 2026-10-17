-- 0045: Ethan (ethan@10xid.com) holds every role Paolo holds.
--
-- WHY. Ethan's decision as operator, of 2026-10-17: everything available to
-- Paolo is available to Ethan. 0044 made him staff of the house; Paolo also
-- belongs to client businesses in his own right (Branding Centres, and owner
-- of Vinyl Wrap Toronto since 0029), and those memberships are what open a
-- business in the portal and decide what he may do there.
--
-- WHAT IT DOES. For each live membership of paolo@tboxstudio.com in a live
-- company, gives Ethan's live account the same role there: created if he has
-- none, changed to Paolo's role if he has another. His memberships where
-- Paolo has none stay as they are. Each change is written to the company's
-- audit trail. It takes effect at his next sign-in.
--
-- SKIPS, never raises: no live account for either of them.
--
-- IDEMPOTENT. A second run finds every role already matching.

DO $$
DECLARE
  v_paolo uuid;
  v_ethan uuid;
  r       record;
  v_have  text;
  v_n     int := 0;
BEGIN
  SELECT id INTO v_paolo FROM users WHERE email = 'paolo@tboxstudio.com' AND deleted_at IS NULL;
  SELECT id INTO v_ethan FROM users WHERE email = 'ethan@10xid.com' AND deleted_at IS NULL;
  IF v_paolo IS NULL OR v_ethan IS NULL THEN
    RAISE NOTICE '[ethan] SKIPPED — no live account for %.', CASE WHEN v_paolo IS NULL THEN 'paolo@tboxstudio.com' ELSE 'ethan@10xid.com' END;
    RETURN;
  END IF;

  FOR r IN
    SELECT m.organization_id, m.role, o.slug
      FROM memberships m
      JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = v_paolo AND o.deleted_at IS NULL
     ORDER BY o.slug
  LOOP
    SELECT role::text INTO v_have FROM memberships WHERE user_id = v_ethan AND organization_id = r.organization_id;
    IF v_have = r.role::text THEN
      RAISE NOTICE '[ethan] already present  % as %', r.slug, r.role;
      CONTINUE;
    ELSIF v_have IS NULL THEN
      INSERT INTO memberships (user_id, organization_id, role) VALUES (v_ethan, r.organization_id, r.role);
      RAISE NOTICE '[ethan] CREATED  % as %', r.slug, r.role;
    ELSE
      UPDATE memberships SET role = r.role, updated_at = now() WHERE user_id = v_ethan AND organization_id = r.organization_id;
      RAISE NOTICE '[ethan] CHANGED  % % -> %', r.slug, v_have, r.role;
    END IF;
    INSERT INTO audit_events (organization_id, actor_user_id, action, target)
    VALUES (r.organization_id, NULL, 'membership.role_changed',
            'ethan@10xid.com: ' || coalesce(v_have, 'none') || ' -> ' || r.role::text || ' (migration 0045, as paolo@tboxstudio.com)');
    v_n := v_n + 1;
  END LOOP;

  RAISE NOTICE '[ethan] % membership(s) written.', v_n;
END
$$;
