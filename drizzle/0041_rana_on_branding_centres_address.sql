-- 0041: Rana's account moves to web@brandingcentres.com.
--
-- WHY. 0012 made Rana's account on rana@vinylwraptoronto.com. Paolo's decision
-- of 2026-10-17: her address is web@brandingcentres.com, the one UID_SITES and
-- UID_HOMES name for uid-rana.10xid.com. Both key on the account's primary
-- address (users.email), so until it changes, signing in as Rana neither ends
-- at her UiD nor is let into it.
--
-- WHAT IT DOES. One block, on the account that holds the old address:
--   1. Its primary address becomes the new one, in users.email and in its
--      primary user_emails row. The old address is not kept as a spare. The
--      new one is not marked verified here: that was a proof of the old one.
--   2. If the account is bound to a sign-in identity still on the old
--      address, that identity's address changes too, so Rana signs in as
--      web@brandingcentres.com with the same password and authenticator.
--      Its email_verified is left as it is, so 0022's first-proof trigger does
--      not fire and nothing she set up is wiped.
-- An unbound account needs nothing more: signing in as the new address asks
-- an operator to confirm the binding, as for any account from before.
--
-- SKIPS, never raises, on: no account on the old address; the new address
-- already held by another account; or a separate identity already on the new
-- address (that identity is left for an operator, and Rana keeps signing in
-- with the old address). An exception would fail the pre-deploy step and take
-- the whole deploy down over one account.
--
-- IDEMPOTENT. A second run finds no account on the old address and the new
-- one in place, and writes nothing.
--
-- THE LOG IS THE ONLY READ PATH. Notices reach the deploy log through the
-- `notice` listener in scripts/migrate.mjs.

DO $$
DECLARE
  v_old       constant text := 'rana@vinylwraptoronto.com';
  v_new       constant text := 'web@brandingcentres.com';
  v_user_id   uuid;
  v_auth_id   text;
  v_auth_mail text;
  v_org_id    uuid;
BEGIN
  RAISE NOTICE '[rana] ======== % -> % ========', v_old, v_new;

  SELECT u.id, u.auth_user_id INTO v_user_id, v_auth_id
    FROM users u WHERE u.email = v_old AND u.deleted_at IS NULL;
  IF v_user_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM users u WHERE u.email = v_new AND u.deleted_at IS NULL) THEN
      RAISE NOTICE '[rana] already present  an account is on %. Nothing written.', v_new;
    ELSE
      RAISE NOTICE '[rana] SKIPPED — no live account on %. Nothing written.', v_old;
    END IF;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM user_emails e WHERE e.email = v_new AND e.user_id <> v_user_id) THEN
    RAISE NOTICE '[rana] SKIPPED — % is already an address of another account. Nothing written.', v_new;
    RETURN;
  END IF;

  -- A spare of the same account on the new address would collide with the
  -- primary taking it; the primary is what it becomes.
  DELETE FROM user_emails WHERE user_id = v_user_id AND email = v_new AND NOT is_primary;
  UPDATE user_emails SET email = v_new, verified_at = NULL
   WHERE user_id = v_user_id AND is_primary;
  UPDATE users SET email = v_new, email_verified_at = NULL, updated_at = now()
   WHERE id = v_user_id;
  RAISE NOTICE '[rana] CHANGED  account % is now on %', v_user_id, v_new;

  IF v_auth_id IS NULL THEN
    RAISE NOTICE '[rana] not bound to a sign-in yet: signing in as % asks an operator to confirm.', v_new;
  ELSE
    SELECT a.email INTO v_auth_mail FROM auth_users a WHERE a.id = v_auth_id;
    IF v_auth_mail = v_new THEN
      RAISE NOTICE '[rana] sign-in identity already on %.', v_new;
    ELSIF EXISTS (SELECT 1 FROM auth_users a WHERE a.email = v_new) THEN
      RAISE NOTICE '[rana] SKIPPED identity — another sign-in identity is on %; % still signs in as %.', v_new, v_user_id, v_auth_mail;
    ELSIF v_auth_mail = v_old THEN
      UPDATE auth_users SET email = v_new, updated_at = now() WHERE id = v_auth_id;
      RAISE NOTICE '[rana] CHANGED  sign-in identity % now signs in as %', v_auth_id, v_new;
    ELSE
      RAISE NOTICE '[rana] sign-in identity is on %, not %; left as it is.', v_auth_mail, v_old;
    END IF;
  END IF;

  SELECT o.id INTO v_org_id FROM organizations o WHERE o.slug = 'vinyl-wrap-toronto' AND o.deleted_at IS NULL;
  IF v_org_id IS NOT NULL THEN
    INSERT INTO audit_events (organization_id, actor_user_id, action, target)
    VALUES (v_org_id, NULL, 'user.email_changed', v_old || ' -> ' || v_new || ' (migration 0041)');
  END IF;
END
$$;
