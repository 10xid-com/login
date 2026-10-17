-- 0042: emailed codes are stored encrypted, not hashed.
--
-- WHY. Asking for a code again, from any device, now sends the same code
-- while it is still good instead of a new one (resendStrategy "reuse" in
-- lib/auth/auth.ts), so a code in the mailbox keeps working whichever device
-- asked last. Sending it again needs it readable, so Better Auth stores it
-- encrypted with BETTER_AUTH_SECRET.
--
-- WHAT IT DOES. Removes the sign-in and password-reset codes still waiting,
-- which were stored hashed: the new code would try to decrypt one, and fail
-- with an error instead of "That code is not right". They last ten minutes
-- anyway; anybody halfway through signing in asks for a code again. Nothing
-- else in auth_verifications (OAuth state, Better Auth's locks) is touched.
--
-- IDEMPOTENT. A second run finds none of the old ones.

DO $$
DECLARE
  v_n int;
BEGIN
  DELETE FROM auth_verifications
   WHERE identifier LIKE 'sign-in-otp-%'
      OR identifier LIKE 'forget-password-otp-%'
      OR identifier LIKE 'email-verification-otp-%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[codes] % emailed code(s) waiting were removed; they are stored encrypted from now on.', v_n;
END
$$;
