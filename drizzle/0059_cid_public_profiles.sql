-- Only explicitly published company fields belong in this table. No member,
-- job, customer, account or private contact data is copied into public profiles.
CREATE TABLE cid_public_profiles (
  slug text PRIMARY KEY CHECK (slug IN ('rotary','brandingcentres','vinylwraptoronto','wrapauthority','workweartoronto')),
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile)='object'),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
--> statement-breakpoint
ALTER TABLE cid_public_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE cid_public_profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON cid_public_profiles FROM PUBLIC, portal_app, portal_auth;
--> statement-breakpoint
GRANT SELECT ON cid_public_profiles TO portal_app;
--> statement-breakpoint
GRANT UPDATE(profile,version,updated_at,updated_by) ON cid_public_profiles TO portal_app;
--> statement-breakpoint
CREATE POLICY cid_public_read ON cid_public_profiles FOR SELECT TO portal_app USING (
  EXISTS(SELECT 1 FROM organizations o WHERE o.id=organization_id AND o.deleted_at IS NULL)
);
--> statement-breakpoint
CREATE POLICY cid_member_write ON cid_public_profiles FOR UPDATE TO portal_app USING (
  organization_id=nullif(current_setting('app.org_id',true),'')::uuid
  AND EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.organization_id=cid_public_profiles.organization_id
      AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid
      AND u.deleted_at IS NULL AND NOT u.is_service
      AND (m.role::text IN ('owner','manager','editor','publisher') OR EXISTS(
        SELECT 1 FROM permissions p WHERE p.organization_id=m.organization_id AND p.user_id=m.user_id
          AND p.capability='cid.profile.write' AND NOT p.deny AND p.scope_type='organization' AND p.scope_id IS NULL AND p.revoked_at IS NULL))
      AND NOT EXISTS(SELECT 1 FROM permissions p WHERE p.organization_id=m.organization_id AND p.user_id=m.user_id
        AND p.capability='cid.profile.write' AND p.deny AND p.scope_type='organization' AND p.scope_id IS NULL AND p.revoked_at IS NULL))
  AND EXISTS(SELECT 1 FROM organizations o WHERE o.id=organization_id AND o.deleted_at IS NULL)
) WITH CHECK (
  organization_id=nullif(current_setting('app.org_id',true),'')::uuid
  AND updated_by=nullif(current_setting('app.user_id',true),'')::uuid
);
--> statement-breakpoint
-- Exact existing business slugs: rotary-store is the merchandise business,
-- deliberately not the separate rotary club record. Never rename/merge identities.
DO $$
DECLARE r record; v_org uuid; v_owner uuid; v_count int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('rotary','rotary-store','Rotary'),
    ('brandingcentres','branding-centres','Branding Centres'),
    ('vinylwraptoronto','vinyl-wrap-toronto','Vinyl Wrap Toronto'),
    ('wrapauthority','wrap-authority','Wrap Authority'),
    ('workweartoronto','workwear-toronto','Workwear Toronto')
  ) AS c(slug,org_slug,display_name)
  LOOP
    SELECT id INTO v_org FROM organizations WHERE slug=r.org_slug AND deleted_at IS NULL;
    IF v_org IS NULL AND r.slug='wrapauthority' THEN
      -- Only the requested missing brand may be provisioned, under its existing
      -- verified TBox owner. No users are created and nobody else's role changes.
      SELECT count(DISTINCT u.id) INTO v_count FROM users u JOIN user_emails e ON e.user_id=u.id
        JOIN memberships m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id
        WHERE e.email='paolo@tboxstudio.com' AND (e.is_primary OR e.verified_at IS NOT NULL)
          AND u.deleted_at IS NULL AND NOT u.is_service AND m.role::text='owner'
          AND o.slug='tbox-studio' AND o.deleted_at IS NULL;
      IF v_count=1 AND NOT EXISTS(SELECT 1 FROM organizations WHERE slug=r.org_slug OR (lower(name)='wrap authority' AND deleted_at IS NULL)) THEN
        SELECT DISTINCT u.id INTO v_owner FROM users u JOIN user_emails e ON e.user_id=u.id
          JOIN memberships m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id
          WHERE e.email='paolo@tboxstudio.com' AND (e.is_primary OR e.verified_at IS NOT NULL)
            AND u.deleted_at IS NULL AND NOT u.is_service AND m.role::text='owner'
            AND o.slug='tbox-studio' AND o.deleted_at IS NULL;
        INSERT INTO organizations(type,name,slug) VALUES('client',r.display_name,r.org_slug) RETURNING id INTO v_org;
        INSERT INTO memberships(organization_id,user_id,role) VALUES(v_org,v_owner,'owner');
        INSERT INTO audit_events(organization_id,actor_user_id,action,target)
          VALUES(v_org,v_owner,'cid.company_provisioned','Wrap Authority (0059, CiD rollout)');
      END IF;
    END IF;
    IF v_org IS NULL THEN
      RAISE NOTICE '[0059] % needs explicit organization mapping; no profile or permission created.',r.slug;
      CONTINUE;
    END IF;
    INSERT INTO cid_public_profiles(slug,organization_id,profile)
      VALUES(r.slug,v_org,jsonb_build_object('displayName',r.display_name,'showOwnership',false)) ON CONFLICT DO NOTHING;
    RAISE NOTICE '[0059] % public profile connected to existing organization %.',r.slug,v_org;
  END LOOP;
END
$$;
