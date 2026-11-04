-- Paolo requested Clothing Inventory editing for Rana's existing UiD account.
-- Confirmed from production UID_SITES/UID_HOMES and the bound Rana account:
-- uid-rana.10xid.com -> web@brandingcentres.com. No sign-in account is created.
DO $$
DECLARE
  v_org uuid;
  v_user uuid;
  v_actor uuid;
  v_count integer;
  v_role text;
BEGIN
  SELECT id INTO v_org FROM organizations WHERE slug='tbox-studio' AND deleted_at IS NULL;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Rana inventory setup requires the existing TBox business.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('memberships_owner:' || v_org::text,0));

  SELECT count(DISTINCT u.id) INTO v_count FROM users u JOIN user_emails e ON e.user_id=u.id
   WHERE e.email='web@brandingcentres.com' AND (e.is_primary OR e.verified_at IS NOT NULL)
     AND u.full_name='Rana' AND u.auth_user_id IS NOT NULL AND u.deleted_at IS NULL AND NOT u.is_service;
  IF v_count<>1 THEN RAISE EXCEPTION 'Rana inventory setup requires one existing, sign-in-linked Rana account at web@brandingcentres.com.'; END IF;
  SELECT DISTINCT u.id INTO v_user FROM users u JOIN user_emails e ON e.user_id=u.id
   WHERE e.email='web@brandingcentres.com' AND (e.is_primary OR e.verified_at IS NOT NULL)
     AND u.full_name='Rana' AND u.auth_user_id IS NOT NULL AND u.deleted_at IS NULL AND NOT u.is_service;

  SELECT count(DISTINCT u.id) INTO v_count FROM users u JOIN user_emails e ON e.user_id=u.id
    JOIN memberships m ON m.user_id=u.id AND m.organization_id=v_org AND m.role='owner'
   WHERE e.email='paolo@tboxstudio.com' AND (e.is_primary OR e.verified_at IS NOT NULL)
     AND u.deleted_at IS NULL AND NOT u.is_service;
  IF v_count<>1 THEN RAISE EXCEPTION 'Rana inventory setup requires Paolo as the existing TBox owner.'; END IF;
  SELECT DISTINCT u.id INTO v_actor FROM users u JOIN user_emails e ON e.user_id=u.id
    JOIN memberships m ON m.user_id=u.id AND m.organization_id=v_org AND m.role='owner'
   WHERE e.email='paolo@tboxstudio.com' AND (e.is_primary OR e.verified_at IS NOT NULL)
     AND u.deleted_at IS NULL AND NOT u.is_service;

  -- Do not overwrite a role assigned concurrently or reapply a completed grant.
  IF EXISTS(SELECT 1 FROM audit_events WHERE organization_id=v_org
    AND action='membership.role_and_tools_changed'
    AND target=jsonb_build_object('userId',v_user,'to','viewer','clothing',2,'source','0057_rana_clothing_access')::text) THEN RETURN; END IF;
  SELECT role::text INTO v_role FROM memberships WHERE organization_id=v_org AND user_id=v_user FOR UPDATE;
  IF v_role IS NOT NULL AND v_role<>'viewer' THEN
    RAISE EXCEPTION 'Rana already has a different TBox role (%). Review it before changing access.',v_role;
  END IF;
  INSERT INTO memberships(organization_id,user_id,role) VALUES(v_org,v_user,'viewer')
    ON CONFLICT(user_id,organization_id) DO NOTHING;
  UPDATE permissions SET revoked_at=now() WHERE organization_id=v_org AND user_id=v_user
    AND scope_type='organization' AND scope_id IS NULL AND revoked_at IS NULL
    AND capability IN ('clothing.read','clothing.write','clothing.publish');
  INSERT INTO permissions(organization_id,user_id,capability,scope_type,granted_by)
    VALUES(v_org,v_user,'clothing.read','organization',v_actor),
          (v_org,v_user,'clothing.write','organization',v_actor);
  INSERT INTO audit_events(organization_id,actor_user_id,action,target)
    VALUES(v_org,v_actor,'membership.role_and_tools_changed',
      jsonb_build_object('userId',v_user,'to','viewer','clothing',2,'source','0057_rana_clothing_access')::text);
  RAISE NOTICE '[0057] Rana added to TBox with Clothing Inventory Edit access and a Viewer business role.';
END
$$;
