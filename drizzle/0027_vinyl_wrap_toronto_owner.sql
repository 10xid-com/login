-- 0027: Rana owns Vinyl Wrap Toronto.
--
-- WHY. Vinyl Wrap Toronto (slug vinyl-wrap-toronto) was created by 0012 with
-- three people — Joel, Imran and Rana — as `member`, which 0024 turned into
-- `viewer`. Nothing has ever made anybody its owner, so nobody in the business
-- can invite people, approve an agency's access or connect its website. Paolo's
-- decision of 2026-10-08: Rana (rana@vinylwraptoronto.com) is the owner.
--
-- WHAT IT DOES. Two blocks:
--   1. Reports who belongs to Vinyl Wrap Toronto as found, before anything is
--      written. Production's rows may differ from what 0012 left behind (an
--      owner may have been made since); this is the only window onto that.
--   2. Changes Rana's existing membership to `owner`. It joins nobody and
--      creates no account: no membership, no change.
--
-- `organizations.owner_user_id` is deliberately NOT set, as in 0016: no code
-- path reads it, and writing a column nothing consults invents a meaning for it.
--
-- IDEMPOTENT. A second run finds her already an owner and writes nothing.
-- It skips rather than raising: an exception here would fail the pre-deploy
-- step and take the whole deploy down over one membership.
--
-- THE LOG IS THE ONLY READ PATH. Notices reach the deploy log through the
-- `notice` listener in scripts/migrate.mjs.

DO $$
DECLARE
  v_org_id  uuid;
  r         record;
  v_n       int := 0;
BEGIN
  RAISE NOTICE '[vwt] ======== vinyl-wrap-toronto as found ========';

  SELECT o.id INTO v_org_id FROM organizations o WHERE o.slug = 'vinyl-wrap-toronto';
  IF v_org_id IS NULL THEN
    RAISE NOTICE '[vwt] no company on the slug vinyl-wrap-toronto.';
    RETURN;
  END IF;

  FOR r IN
    SELECT u.email, m.role::text AS role, u.deleted_at IS NOT NULL AS gone
      FROM memberships m
      JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = v_org_id
     ORDER BY u.email
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '[vwt] member  %  % %', r.email, r.role, CASE WHEN r.gone THEN '  (account deleted)' ELSE '' END;
  END LOOP;

  RAISE NOTICE '[vwt] % membership(s) in all.', v_n;
END
$$;

--> statement-breakpoint

DO $$
DECLARE
  v_org_id   uuid;
  v_user_id  uuid;
  v_role     text;
  v_email    constant text := 'rana@vinylwraptoronto.com';
BEGIN
  RAISE NOTICE '[vwt] ======== % on vinyl-wrap-toronto ========', v_email;

  SELECT o.id INTO v_org_id
    FROM organizations o
   WHERE o.slug = 'vinyl-wrap-toronto' AND o.type = 'client' AND o.deleted_at IS NULL;
  IF v_org_id IS NULL THEN
    RAISE NOTICE '[vwt] SKIPPED — no live client company on the slug vinyl-wrap-toronto. Nothing written.';
    RETURN;
  END IF;

  -- users.email is the denormalised copy of the primary address.
  SELECT u.id INTO v_user_id FROM users u WHERE u.email = v_email AND u.deleted_at IS NULL;
  IF v_user_id IS NULL THEN
    RAISE NOTICE '[vwt] SKIPPED — no live account on %. Nothing written.', v_email;
    RETURN;
  END IF;

  SELECT m.role::text INTO v_role
    FROM memberships m
   WHERE m.user_id = v_user_id AND m.organization_id = v_org_id;
  IF v_role IS NULL THEN
    RAISE NOTICE '[vwt] SKIPPED — % holds no membership of vinyl-wrap-toronto, and this does not create one. Nothing written.', v_email;
    RETURN;
  END IF;

  IF v_role = 'owner' THEN
    RAISE NOTICE '[vwt] already present  % is already owner. Nothing written.', v_email;
    RETURN;
  END IF;

  UPDATE memberships
     SET role = 'owner', updated_at = now()
   WHERE user_id = v_user_id AND organization_id = v_org_id;

  -- On the business's own record. No actor: this is a decision applied by
  -- migration, not by a person in the portal.
  INSERT INTO audit_events (organization_id, actor_user_id, action, target)
  VALUES (v_org_id, NULL, 'membership.role_changed', v_email || ': ' || v_role || ' -> owner (migration 0027)');

  RAISE NOTICE '[vwt] CHANGED  % % -> owner', v_email, v_role;
END
$$;
