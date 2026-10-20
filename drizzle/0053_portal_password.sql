-- 0053: a password for the portal's own sign-in (app.10xid.com).
--
-- WHY. Paolo's decision of 2026-10-20: signing in on the portal offers a
-- password as well as the emailed code. Either is the first step; the
-- authenticator is still the second, every time.
--
-- WHAT IT DOES. Adds users.password_hash (scrypt, "salt.hash", nullable: no
-- password until the person sets one on the portal's security page). The
-- portal's role already holds UPDATE on users (0001). Nothing else changes.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;
