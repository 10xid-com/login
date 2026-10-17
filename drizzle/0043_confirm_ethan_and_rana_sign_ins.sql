-- 0043: confirm the sign-ins of Ethan (ethan@10xid.com) and Rana
-- (web@brandingcentres.com).
--
-- WHY. Both accounts existed before their sign-ins, so each first sign-in
-- stopped at "Waiting for confirmation" (lib/auth/login: binding_requested).
-- An operator confirms that on /auth/operator, and the only operator with a
-- confirmed sign-in (Paolo) can't get past his authenticator. Ethan, listed in
-- OPERATOR_EMAILS since 2026-10-17, can't confirm himself either: the
-- first-operator door (lib/auth/operator) shuts once any operator is bound.
-- This applies the operator decision of 2026-10-17 to confirm both.
--
-- WHAT IT DOES. For each of the two addresses, finds the open binding request
-- for exactly that address whose sign-in identity is on that same, verified
-- address, and confirms it through operator_decide_binding (0023), which makes
-- every check the operator screen does (account live and not already bound,
-- the address the account's own, the identity not bound elsewhere). Nothing
-- else is bound. The authenticator is still required on every sign-in.
--
-- SKIPS, never raises: no open request, or more than one, or an identity not
-- on that verified address. Its answer goes to the deploy log.
--
-- IDEMPOTENT. A confirmed request is no longer open; a second run finds none.

DO $$
DECLARE
  v_email text;
  v_ids   uuid[];
  v_out   text;
BEGIN
  FOREACH v_email IN ARRAY ARRAY['ethan@10xid.com', 'web@brandingcentres.com'] LOOP
    SELECT array_agg(b.id) INTO v_ids
      FROM identity_bindings b
      JOIN auth_users a ON a.id = b.auth_user_id
     WHERE b.decision IS NULL
       AND b.email = v_email
       AND a.email = v_email
       AND a.email_verified;

    IF v_ids IS NULL THEN
      RAISE NOTICE '[bind] SKIPPED % — no open sign-in request on that verified address.', v_email;
    ELSIF array_length(v_ids, 1) > 1 THEN
      RAISE NOTICE '[bind] SKIPPED % — % open requests; an operator picks one.', v_email, array_length(v_ids, 1);
    ELSE
      v_out := operator_decide_binding(v_ids[1], true, 'Ethan (operator), migration 0043');
      RAISE NOTICE '[bind] % → %', v_email, v_out;
    END IF;
  END LOOP;
END
$$;
