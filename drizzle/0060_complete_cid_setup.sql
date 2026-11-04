-- Paolo requested completion of Workwear editing access and Rotary's public
-- contact/location fields. No other person's membership or tool grants change.
-- Contact evidence: https://rotary.brandingcentres.com/contact (2026-11-04).
-- That page publishes no dedicated Rotary-store social accounts; none are guessed.
DO $$
DECLARE
  v_person uuid;
  v_workwear uuid;
  v_rotary uuid;
  v_count integer;
  v_role text;
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_value text;
BEGIN
  SELECT count(DISTINCT u.id) INTO v_count
    FROM users u JOIN user_emails e ON e.user_id=u.id
    JOIN memberships m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id
    WHERE e.email='paolo@tboxstudio.com' AND (e.is_primary OR e.verified_at IS NOT NULL)
      AND u.auth_user_id IS NOT NULL AND u.deleted_at IS NULL AND NOT u.is_service
      AND o.slug='tbox-studio' AND o.deleted_at IS NULL AND m.role::text='owner';
  IF v_count=0 THEN
    RAISE NOTICE '[0060] No existing sign-in-linked TBox owner account; completion skipped without granting access.';
    RETURN;
  END IF;
  IF v_count<>1 THEN RAISE EXCEPTION 'CiD completion requires exactly one verified Paolo TBox owner account.'; END IF;
  SELECT DISTINCT u.id INTO v_person
    FROM users u JOIN user_emails e ON e.user_id=u.id
    JOIN memberships m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id
    WHERE e.email='paolo@tboxstudio.com' AND (e.is_primary OR e.verified_at IS NOT NULL)
      AND u.auth_user_id IS NOT NULL AND u.deleted_at IS NULL AND NOT u.is_service
      AND o.slug='tbox-studio' AND o.deleted_at IS NULL AND m.role::text='owner';

  SELECT o.id INTO v_workwear FROM organizations o JOIN cid_public_profiles p ON p.organization_id=o.id
    WHERE o.slug='workwear-toronto' AND o.deleted_at IS NULL AND p.slug='workweartoronto';
  SELECT o.id INTO v_rotary FROM organizations o JOIN cid_public_profiles p ON p.organization_id=o.id
    WHERE o.slug='rotary-store' AND o.deleted_at IS NULL AND p.slug='rotary';
  IF v_workwear IS NULL OR v_rotary IS NULL THEN
    RAISE EXCEPTION 'CiD completion requires the existing Workwear and Rotary-store profile mappings.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('memberships_owner:' || v_workwear::text,0));
  IF EXISTS(SELECT 1 FROM permissions WHERE organization_id=v_workwear AND user_id=v_person
    AND capability='cid.profile.write' AND deny AND scope_type='organization' AND scope_id IS NULL AND revoked_at IS NULL)
    THEN RAISE EXCEPTION 'Workwear has an explicit profile editing denial; review it before changing access.'; END IF;
  SELECT role::text INTO v_role FROM memberships WHERE organization_id=v_workwear AND user_id=v_person FOR UPDATE;
  IF v_role IS NULL THEN
    INSERT INTO memberships(organization_id,user_id,role) VALUES(v_workwear,v_person,'editor');
    INSERT INTO audit_events(organization_id,actor_user_id,action,target)
      VALUES(v_workwear,v_person,'membership.created',jsonb_build_object('userId',v_person,'role','editor','source','0060_complete_cid_setup')::text);
  ELSIF v_role IN ('viewer','member','staff','asset_manager') THEN
    UPDATE memberships SET role='editor',updated_at=now() WHERE organization_id=v_workwear AND user_id=v_person;
    INSERT INTO audit_events(organization_id,actor_user_id,action,target)
      VALUES(v_workwear,v_person,'membership.role_changed',jsonb_build_object('userId',v_person,'from',v_role,'to','editor','source','0060_complete_cid_setup')::text);
  ELSIF v_role NOT IN ('editor','owner','manager','publisher') THEN
    RAISE EXCEPTION 'Unexpected Workwear role; review it before changing access.';
  END IF;
  RAISE NOTICE '[0060] Paolo has assigned Workwear profile-editing membership; other memberships and grants unchanged.';

  SELECT profile INTO v_old FROM cid_public_profiles WHERE slug='rotary' AND organization_id=v_rotary FOR UPDATE;
  v_new := v_old;
  FOR v_key,v_value IN SELECT * FROM (VALUES
    ('email','Rotary@BrandingCentres.com'),
    ('phone','+1 416-288-8661'),
    ('address','24 Ronson Drive, Unit 1, Etobicoke, ON M9W 1B4, Canada'),
    ('mapsUrl','https://www.google.com/maps/dir/?api=1&destination=24+Ronson+Dr,+Etobicoke,+ON+M9W+1B4')
  ) AS published(field,value)
  LOOP
    -- Only fill empty fields. Preserve anything a company editor has published.
    IF coalesce(v_new->>v_key,'')='' THEN v_new:=jsonb_set(v_new,ARRAY[v_key],to_jsonb(v_value),true); END IF;
  END LOOP;
  IF v_new IS DISTINCT FROM v_old THEN
    UPDATE cid_public_profiles SET profile=v_new,version=version+1,updated_at=now(),updated_by=v_person
      WHERE slug='rotary' AND organization_id=v_rotary;
    INSERT INTO audit_events(organization_id,actor_user_id,action,target)
      VALUES(v_rotary,v_person,'cid.profile_published','rotary: verified empty contact/location fields completed (0060)');
  END IF;
  RAISE NOTICE '[0060] Rotary contact/location completion finished; published values and social choices preserved.';
END
$$;
