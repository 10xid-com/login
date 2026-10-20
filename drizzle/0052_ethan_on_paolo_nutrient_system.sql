-- 0052: Ethan (ethan@10xid.com) becomes an owner of Paolo Nutrient System.
--
-- WHY. Paolo's decision of 2026-10-20: the private business that holds the
-- inventory ("Paolo Nutrient System", the only one INVENTORY_BUSINESSES
-- switches Inventory on for) is opened to Ethan's account as well. Inventory
-- is owners-only, so he is made an owner. Paolo stays an owner: nothing of
-- his changes. 0045 gave Ethan Paolo's roles in the businesses that existed
-- then; this one came later.
--
-- WHAT IT DOES. Gives Ethan's live account an owner membership in the one live
-- client business named "Paolo Nutrient System" (created if he has none,
-- changed to owner if he has another role), and writes it to the business's
-- audit trail. It takes effect at his next request.
--
-- SKIPS, never raises: no live account for Ethan, or not exactly one such
-- business.
--
-- IDEMPOTENT. A second run finds him already an owner.

DO $$
DECLARE
  v_ethan uuid;
  v_org   uuid;
  v_count int;
  v_have  text;
BEGIN
  SELECT id INTO v_ethan FROM users WHERE email = 'ethan@10xid.com' AND deleted_at IS NULL;
  IF v_ethan IS NULL THEN
    RAISE NOTICE '[0052] SKIPPED — no live account for ethan@10xid.com.';
    RETURN;
  END IF;

  SELECT count(*) INTO v_count FROM organizations
   WHERE name = 'Paolo Nutrient System' AND type = 'client' AND deleted_at IS NULL;
  IF v_count <> 1 THEN
    RAISE NOTICE '[0052] SKIPPED — % live client businesses named Paolo Nutrient System, expected 1.', v_count;
    RETURN;
  END IF;
  SELECT id INTO v_org FROM organizations
   WHERE name = 'Paolo Nutrient System' AND type = 'client' AND deleted_at IS NULL;

  SELECT role::text INTO v_have FROM memberships WHERE user_id = v_ethan AND organization_id = v_org;
  IF v_have = 'owner' THEN
    RAISE NOTICE '[0052] already an owner.';
    RETURN;
  ELSIF v_have IS NULL THEN
    INSERT INTO memberships (user_id, organization_id, role) VALUES (v_ethan, v_org, 'owner');
    INSERT INTO audit_events (organization_id, actor_user_id, action, target)
    VALUES (v_org, NULL, 'membership.created', 'ethan@10xid.com: none -> owner (migration 0052, Paolo''s decision)');
    RAISE NOTICE '[0052] CREATED owner membership.';
  ELSE
    UPDATE memberships SET role = 'owner', updated_at = now() WHERE user_id = v_ethan AND organization_id = v_org;
    INSERT INTO audit_events (organization_id, actor_user_id, action, target)
    VALUES (v_org, NULL, 'membership.role_changed', 'ethan@10xid.com: ' || v_have || ' -> owner (migration 0052, Paolo''s decision)');
    RAISE NOTICE '[0052] CHANGED % -> owner.', v_have;
  END IF;
END
$$;
