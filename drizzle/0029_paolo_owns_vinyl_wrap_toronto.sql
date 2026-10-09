-- 0029: Paolo is an owner of Vinyl Wrap Toronto, alongside Rana.
--
-- WHY. paolo@tboxstudio.com belongs to Branding Centres only, so the portal
-- opens Branding Centres and offers no business to switch to. He runs Vinyl
-- Wrap Toronto's website from the portal (the Website channel, Chat Boss's blog
-- drafts), which needs the business open. Paolo's decision of 2026-10-09: owner
-- of Vinyl Wrap Toronto, and keep Branding Centres.
--
-- WHAT IT DOES. Gives the account an `owner` membership of Vinyl Wrap Toronto:
--   - none yet          → creates it as owner
--   - another role      → raises it to owner
--   - already owner     → nothing
-- Branding Centres is not touched, and Rana stays an owner. With two
-- businesses the portal's account menu shows "Switch business".
--
-- It creates no account: no live user on the address, no change.
--
-- IDEMPOTENT. A second run finds him already an owner and writes nothing. It
-- skips rather than raising: an exception here would fail the pre-deploy step
-- and take the whole deploy down over one membership.
--
-- THE LOG IS THE ONLY READ PATH. Notices reach the deploy log through the
-- `notice` listener in scripts/migrate.mjs.

DO $$
DECLARE
  v_org_id   uuid;
  v_user_id  uuid;
  v_role     text;
  v_email    constant text := 'paolo@tboxstudio.com';
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
  SELECT u.id INTO v_user_id FROM users u WHERE lower(u.email) = v_email AND u.deleted_at IS NULL;
  IF v_user_id IS NULL THEN
    RAISE NOTICE '[vwt] SKIPPED — no live account on %. Nothing written.', v_email;
    RETURN;
  END IF;

  SELECT m.role::text INTO v_role
    FROM memberships m
   WHERE m.user_id = v_user_id AND m.organization_id = v_org_id;

  IF v_role = 'owner' THEN
    RAISE NOTICE '[vwt] already present  % is already owner. Nothing written.', v_email;
    RETURN;
  END IF;

  IF v_role IS NULL THEN
    INSERT INTO memberships (user_id, organization_id, role)
    VALUES (v_user_id, v_org_id, 'owner');
    -- On the business's own record. No actor: a decision applied by
    -- migration, not by a person in the portal.
    INSERT INTO audit_events (organization_id, actor_user_id, action, target)
    VALUES (v_org_id, NULL, 'membership.created', v_email || ': owner (migration 0029)');
    RAISE NOTICE '[vwt] CREATED  % as owner', v_email;
  ELSE
    UPDATE memberships
       SET role = 'owner', updated_at = now()
     WHERE user_id = v_user_id AND organization_id = v_org_id;
    INSERT INTO audit_events (organization_id, actor_user_id, action, target)
    VALUES (v_org_id, NULL, 'membership.role_changed', v_email || ': ' || v_role || ' -> owner (migration 0029)');
    RAISE NOTICE '[vwt] CHANGED  % % -> owner', v_email, v_role;
  END IF;
END
$$;
