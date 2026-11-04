-- Members feature: Paolo administers TBox through an explicit business role.
-- Prepared for Paolo's review with the shared UiD Members rollout, 2026-11-04.
-- This is software authority in TBox only; it conveys no authority over other
-- businesses or customer-owned identities and gives no other UiD tool access.
-- Require the existing, verified account and its existing TBox membership.
DO $$
DECLARE
  v_org uuid;
  v_user uuid;
  v_count integer;
  v_role text;
BEGIN
  SELECT id INTO v_org FROM organizations WHERE slug='tbox-studio' AND deleted_at IS NULL;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Members setup requires the existing TBox business. Confirm its mapping before deploying.';
  END IF;
  SELECT count(DISTINCT u.id) INTO v_count
    FROM users u JOIN user_emails e ON e.user_id=u.id
    JOIN memberships m ON m.user_id=u.id AND m.organization_id=v_org
   WHERE u.deleted_at IS NULL AND NOT u.is_service
     AND e.email='paolo@tboxstudio.com' AND (e.is_primary OR e.verified_at IS NOT NULL);
  IF v_count<>1 THEN
    RAISE EXCEPTION 'Members setup requires one existing Paolo membership in TBox. Confirm the account before deploying.';
  END IF;
  SELECT u.id,m.role::text INTO v_user,v_role
    FROM users u JOIN user_emails e ON e.user_id=u.id
    JOIN memberships m ON m.user_id=u.id AND m.organization_id=v_org
   WHERE u.deleted_at IS NULL AND NOT u.is_service
     AND e.email='paolo@tboxstudio.com' AND (e.is_primary OR e.verified_at IS NOT NULL)
   LIMIT 1;
  IF v_role='owner' THEN RETURN; END IF;
  -- An unexpected modern role is a decision to review, not a legacy setup to repair.
  IF v_role NOT IN ('staff','member') THEN
    RAISE EXCEPTION 'Paolo has a non-legacy TBox role (%). Review that role before enabling Members.',v_role;
  END IF;
  UPDATE memberships SET role='owner',updated_at=now()
   WHERE organization_id=v_org AND user_id=v_user AND role::text=v_role;
  INSERT INTO audit_events(organization_id,actor_user_id,action,target)
   VALUES(v_org,NULL,'membership.role_changed',v_user::text || ': ' || v_role || ' -> owner (0056, approved UiD Members rollout)');
END
$$;
