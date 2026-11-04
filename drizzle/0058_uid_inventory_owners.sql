-- Inventory ownership determines Personal versus Shared in a person's UiD.
-- This records the owner of a collection, not the owner of its stock or its
-- business. Memberships and tool permissions remain the access authority.
CREATE TABLE uid_inventory_owners (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  tool text NOT NULL CHECK (tool IN ('inventory', 'clothing')),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, tool)
);
--> statement-breakpoint
CREATE INDEX uid_inventory_owners_person ON uid_inventory_owners(owner_user_id);
--> statement-breakpoint
ALTER TABLE uid_inventory_owners ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY uid_inventory_owners_read ON uid_inventory_owners FOR SELECT TO portal_app
USING (
  organization_id = nullif(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.organization_id=uid_inventory_owners.organization_id
      AND m.user_id=nullif(current_setting('app.user_id', true), '')::uuid
      AND u.deleted_at IS NULL AND NOT u.is_service
  )
);
--> statement-breakpoint
REVOKE ALL ON uid_inventory_owners FROM PUBLIC, portal_app, portal_auth;
--> statement-breakpoint
GRANT SELECT ON uid_inventory_owners TO portal_app;
--> statement-breakpoint
-- Paolo identified both existing inventories as his, shared with other members.
-- Store his stable account id. Never infer ownership from an Owner-role grant.
DO $$
DECLARE
  v_owner uuid;
  v_tbox uuid;
  v_nutrients uuid;
  v_count integer;
BEGIN
  SELECT count(DISTINCT u.id) INTO v_count FROM users u
    JOIN user_emails e ON e.user_id=u.id
    WHERE e.email='paolo@tboxstudio.com' AND (e.is_primary OR e.verified_at IS NOT NULL)
      AND u.deleted_at IS NULL AND NOT u.is_service;
  IF v_count=0 THEN
    RAISE NOTICE '[0058] No existing Paolo account; inventory ownership setup skipped.';
    RETURN;
  END IF;
  IF v_count<>1 THEN RAISE EXCEPTION 'Inventory ownership requires one verified Paolo account.'; END IF;
  SELECT DISTINCT u.id INTO v_owner FROM users u JOIN user_emails e ON e.user_id=u.id
    WHERE e.email='paolo@tboxstudio.com' AND (e.is_primary OR e.verified_at IS NOT NULL)
      AND u.deleted_at IS NULL AND NOT u.is_service;
  SELECT id INTO v_tbox FROM organizations WHERE slug='tbox-studio' AND deleted_at IS NULL;
  SELECT count(*) INTO v_count FROM organizations
    WHERE name='Paolo Nutrient System' AND deleted_at IS NULL;
  -- A fresh installation need not contain Paolo's private production inventory.
  -- Keep absence fail-closed: no metadata, membership or permission is created.
  IF v_tbox IS NULL OR v_count=0 THEN
    RAISE NOTICE '[0058] Existing inventory collections not present; ownership setup skipped.';
    RETURN;
  END IF;
  IF v_count<>1 THEN
    RAISE EXCEPTION 'Inventory ownership requires one existing Paolo Nutrient System collection.';
  END IF;
  SELECT id INTO v_nutrients FROM organizations WHERE name='Paolo Nutrient System' AND deleted_at IS NULL;
  SELECT count(*) INTO v_count FROM memberships
    WHERE user_id=v_owner AND organization_id IN (v_tbox,v_nutrients) AND role='owner';
  IF v_count<>2 THEN RAISE EXCEPTION 'Confirm Paolo owns both existing inventory businesses before recording ownership.'; END IF;
  IF EXISTS (
    SELECT 1 FROM uid_inventory_owners
    WHERE ((organization_id=v_tbox AND tool='clothing') OR (organization_id=v_nutrients AND tool='inventory'))
      AND owner_user_id<>v_owner
  ) THEN RAISE EXCEPTION 'An inventory has another recorded owner; review it before changing ownership.'; END IF;
  WITH recorded AS (
    INSERT INTO uid_inventory_owners(organization_id,tool,owner_user_id)
      VALUES(v_tbox,'clothing',v_owner),(v_nutrients,'inventory',v_owner)
      ON CONFLICT(organization_id,tool) DO NOTHING
      RETURNING organization_id,tool
  )
  INSERT INTO audit_events(organization_id,actor_user_id,action,target)
    SELECT organization_id,v_owner,'inventory.owner_recorded',
      jsonb_build_object('tool',tool,'ownerUserId',v_owner,'source','0058_uid_inventory_owners')::text
    FROM recorded;
END
$$;
