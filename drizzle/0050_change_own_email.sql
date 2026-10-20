-- 0050: a person changes their own address, from login.10xid.com/auth/account.
--
-- WHY. Until now an address changed only by migration (0041, 0047). The
-- account page now lets a signed-in person move to a new address once a code
-- sent there proves the mailbox (lib/auth/email-change.ts). The sign-in
-- service connects as portal_auth, which may write auth_users but not users
-- or user_emails, and the two must change together: this function does both
-- in one transaction, and portal_auth may call it and nothing more.
--
-- WHAT IT DOES, for the live account bound to that sign-in identity:
--   1. The new address becomes the primary, verified (the code proved it), in
--      user_emails and in the users.email mirror.
--   2. The old one stays on the account as a verified spare. UID_SITES,
--      UID_HOMES and OPERATOR_EMAILS name addresses, and they accept any of
--      an account's verified addresses, so changing address does not lock
--      anybody out of their UiD or the operator screen.
--   3. The sign-in identity moves to the new address. email_verified is left
--      as it is, so 0022's first-proof trigger does not fire and the
--      password, authenticator and sessions carry over.
--
-- REFUSES, never raises: no live account bound to the identity ('no_account');
-- the address already the primary ('unchanged'); held by another account,
-- deleted ones included, or by another sign-in identity ('taken').

CREATE OR REPLACE FUNCTION account_change_email(p_auth_user_id text, p_new text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new  text := lower(btrim(coalesce(p_new, '')));
  v_user record;
BEGIN
  IF v_new !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN RETURN 'invalid'; END IF;

  SELECT u.id, u.email INTO v_user
    FROM users u
   WHERE u.auth_user_id = p_auth_user_id AND u.deleted_at IS NULL AND NOT u.is_service
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'no_account'; END IF;
  IF lower(v_user.email) = v_new THEN RETURN 'unchanged'; END IF;

  IF EXISTS (SELECT 1 FROM user_emails WHERE email = v_new AND user_id <> v_user.id)
     OR EXISTS (SELECT 1 FROM users WHERE lower(email) = v_new AND id <> v_user.id)
     OR EXISTS (SELECT 1 FROM auth_users WHERE email = v_new AND id <> p_auth_user_id) THEN
    RETURN 'taken';
  END IF;

  -- A spare of this account on the new address is what becomes the primary.
  DELETE FROM user_emails WHERE user_id = v_user.id AND email = v_new AND NOT is_primary;
  UPDATE user_emails SET is_primary = false, verified_at = coalesce(verified_at, now())
   WHERE user_id = v_user.id AND is_primary;
  INSERT INTO user_emails (user_id, email, is_primary, verified_at) VALUES (v_user.id, v_new, true, now());
  UPDATE users SET email = v_new, email_verified_at = now(), updated_at = now() WHERE id = v_user.id;
  UPDATE auth_users SET email = v_new, updated_at = now() WHERE id = p_auth_user_id;

  RAISE NOTICE '[email] account % moved from % to %', v_user.id, v_user.email, v_new;
  RETURN 'changed';
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION account_change_email(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION account_change_email(text, text) TO portal_auth;
