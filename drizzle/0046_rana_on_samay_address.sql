-- 0046: Rana's account moves to samay@tboxstudio.com.
--
-- WHY. 0041 moved Rana's account to web@brandingcentres.com, and 0043 bound
-- the sign-in on that address to it. Paolo's decision of 2026-10-17: the
-- address for uid-rana.10xid.com is samay@tboxstudio.com instead. UID_SITES
-- and UID_HOMES key on the account's primary address (users.email), so they
-- name the new address once this has run.
--
-- WHAT IT DOES. One block, on the account that holds the old address:
--   1. Its primary address becomes the new one, in users.email and in its
--      primary user_emails row, unverified, as in 0041.
--   2. Its bound sign-in identity, if still on the old address, moves to the
--      new one and starts over: address unproven, and no password,
--      authenticator, provider link or session. Unlike 0041, nothing set up
--      through web@brandingcentres.com is carried to samay@tboxstudio.com,
--      whose mailbox has proven nothing yet (the reasoning of 0022's
--      first-proof trigger). The binding stays, so samay@tboxstudio.com signs
--      in with an emailed code, sets up an authenticator, and is in, with no
--      operator step.
--   3. The account's portal sessions are revoked.
--
-- SKIPS, never raises, on: no account on the old address; the new address
-- already held by another account (users.email or user_emails, deleted
-- accounts included); or another sign-in identity already on
-- the new address (then nothing at all is written, and the account stays on
-- the old address for an operator to sort out).
--
-- IDEMPOTENT. A second run finds no account on the old address and the new
-- one in place, and writes nothing.
--
-- THE LOG IS THE ONLY READ PATH. Notices reach the deploy log through the
-- `notice` listener in scripts/migrate.mjs.

DO $$
DECLARE
  v_old       constant text := 'web@brandingcentres.com';
  v_new       constant text := 'samay@tboxstudio.com';
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

  -- users.email is unique across deleted accounts too, and need not have a
  -- user_emails row, so both are checked.
  IF EXISTS (SELECT 1 FROM user_emails e WHERE e.email = v_new AND e.user_id <> v_user_id)
     OR EXISTS (SELECT 1 FROM users u WHERE u.email = v_new AND u.id <> v_user_id) THEN
    RAISE NOTICE '[rana] SKIPPED — % is already an address of another account. Nothing written.', v_new;
    RETURN;
  END IF;

  IF v_auth_id IS NOT NULL THEN
    SELECT a.email INTO v_auth_mail FROM auth_users a WHERE a.id = v_auth_id;
  END IF;
  IF EXISTS (SELECT 1 FROM auth_users a WHERE a.email = v_new AND a.id IS DISTINCT FROM v_auth_id) THEN
    RAISE NOTICE '[rana] SKIPPED — another sign-in identity is on %. Nothing written.', v_new;
    RETURN;
  END IF;

  DELETE FROM user_emails WHERE user_id = v_user_id AND email = v_new AND NOT is_primary;
  UPDATE user_emails SET email = v_new, verified_at = NULL
   WHERE user_id = v_user_id AND is_primary;
  UPDATE users SET email = v_new, email_verified_at = NULL, updated_at = now()
   WHERE id = v_user_id;
  RAISE NOTICE '[rana] CHANGED  account % is now on %', v_user_id, v_new;

  IF v_auth_id IS NULL THEN
    RAISE NOTICE '[rana] not bound to a sign-in yet: signing in as % asks an operator to confirm.', v_new;
  ELSIF v_auth_mail = v_new THEN
    RAISE NOTICE '[rana] sign-in identity already on %.', v_new;
  ELSIF v_auth_mail = v_old THEN
    DELETE FROM auth_two_factors WHERE user_id = v_auth_id;
    DELETE FROM auth_accounts WHERE user_id = v_auth_id;
    DELETE FROM auth_sessions WHERE user_id = v_auth_id;
    UPDATE auth_users SET email = v_new, email_verified = false, updated_at = now() WHERE id = v_auth_id;
    RAISE NOTICE '[rana] CHANGED  sign-in identity % is now on %, starting over: emailed code, then a new authenticator.', v_auth_id, v_new;
  ELSE
    RAISE NOTICE '[rana] sign-in identity is on %, not %; left as it is.', v_auth_mail, v_old;
  END IF;

  UPDATE sessions SET revoked_at = now() WHERE user_id = v_user_id AND revoked_at IS NULL;

  SELECT o.id INTO v_org_id FROM organizations o WHERE o.slug = 'vinyl-wrap-toronto' AND o.deleted_at IS NULL;
  IF v_org_id IS NOT NULL THEN
    INSERT INTO audit_events (organization_id, actor_user_id, action, target)
    VALUES (v_org_id, NULL, 'user.email_changed', v_old || ' -> ' || v_new || ' (migration 0046)');
  END IF;
END
$$;
