-- 0050: the portal (app.10xid.com) signs people in itself; everybody sets up
-- a fresh authenticator there.
--
-- WHY. Paolo's decision of 2026-10-20: app.10xid.com is no longer tied to
-- login.10xid.com. It signs people in with an emailed code and then an
-- authenticator app, kept in users.totp_secret / users.totp_confirmed_at and
-- recovery_codes. Those columns last held the legacy sign-in's authenticators
-- (removed here on 2026-10-07), encrypted under a key the portal does not
-- have. The authenticators people use today are the login host's own
-- (auth_two_factors), which the portal's role cannot read and this does not
-- touch.
--
-- WHAT IT DOES. Clears every legacy authenticator and retires every unused
-- legacy recovery code (marked used, as replaceRecoveryCodes() does; never
-- deleted). Each person's first portal sign-in then sets up a new one.
-- Nothing on the login host changes: its sign-in, authenticators and UiD
-- pages are untouched.

UPDATE users
SET totp_secret = NULL, totp_confirmed_at = NULL, updated_at = now()
WHERE totp_secret IS NOT NULL OR totp_confirmed_at IS NOT NULL;
--> statement-breakpoint
UPDATE recovery_codes SET used_at = now() WHERE used_at IS NULL;
