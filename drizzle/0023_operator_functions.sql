-- 0023: what an operator may do, as functions only the login host can call.
--
-- Binding an existing account to a sign-in identity is set once and only by an
-- operator (0022's users_auth_user_id_guard: the table owner, nobody else).
-- Until now that meant a terminal with the owner connection. These functions
-- let the login host's operator screen do it instead, without giving any
-- application role more than it had:
--
--   * SECURITY DEFINER, owned by the table owner, fixed search_path;
--   * EXECUTE granted to portal_auth only — the login service's own sign-in
--     role. portal_app, the role the portal (app.10xid.com) connects as, may
--     not call them, so a compromise of the portal still cannot bind an
--     account or invite anybody anywhere;
--   * each one does exactly one checked thing; who the operator is, and that
--     they just passed their authenticator, is checked by the login host
--     before it calls (lib/auth/operator.ts).
--
-- Additive: functions and grants only.

CREATE OR REPLACE FUNCTION operator_open_bindings()
RETURNS TABLE (
  id uuid,
  email text,
  auth_user_id text,
  requested_at timestamptz,
  account_email text,
  full_name text,
  businesses text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT b.id, b.email, b.auth_user_id, b.requested_at, u.email, u.full_name,
         coalesce(
           (SELECT string_agg(o.name || ' (' || m.role || ')', ', ' ORDER BY o.name)
              FROM memberships m JOIN organizations o ON o.id = m.organization_id
             WHERE m.user_id = u.id AND o.deleted_at IS NULL),
           'no businesses')
    FROM identity_bindings b
    JOIN users u ON u.id = b.user_id
   WHERE b.decision IS NULL AND b.auth_user_id IS NOT NULL
   ORDER BY b.requested_at;
$$;--> statement-breakpoint

-- The same checks as scripts/identity-bindings.mjs `confirm` / `reject`.
CREATE OR REPLACE FUNCTION operator_decide_binding(p_request uuid, p_confirm boolean, p_decided_by text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  IF coalesce(btrim(p_decided_by), '') = '' THEN
    RETURN 'no_operator';
  END IF;

  SELECT b.*, u.auth_user_id AS bound_to, u.deleted_at AS account_deleted_at
    INTO r
    FROM identity_bindings b JOIN users u ON u.id = b.user_id
   WHERE b.id = p_request AND b.auth_user_id IS NOT NULL
   FOR UPDATE OF b, u;

  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF r.decision IS NOT NULL THEN RETURN 'already_decided'; END IF;

  IF p_confirm THEN
    IF r.account_deleted_at IS NOT NULL THEN RETURN 'account_deleted'; END IF;
    IF r.bound_to IS NOT NULL THEN RETURN 'already_bound'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM user_emails
       WHERE user_id = r.user_id AND email = r.email
         AND (is_primary OR verified_at IS NOT NULL)
    ) THEN
      RETURN 'address_not_owned';
    END IF;
    IF EXISTS (SELECT 1 FROM users WHERE auth_user_id = r.auth_user_id) THEN
      RETURN 'identity_taken';
    END IF;
    UPDATE users SET auth_user_id = r.auth_user_id, updated_at = now() WHERE id = r.user_id;
  END IF;

  UPDATE identity_bindings
     SET decision = CASE WHEN p_confirm THEN 'confirmed' ELSE 'rejected' END,
         decided_at = now(),
         decided_by = btrim(p_decided_by)
   WHERE id = p_request;

  RETURN CASE WHEN p_confirm THEN 'confirmed' ELSE 'rejected' END;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION operator_client_businesses()
RETURNS TABLE (id uuid, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, name FROM organizations
   WHERE type = 'client' AND deleted_at IS NULL
   ORDER BY name;
$$;--> statement-breakpoint

-- Invite an address into one client business. Re-inviting the same address to
-- the same business replaces the outstanding invitation rather than stacking
-- a second, exactly as the portal's own invite does.
CREATE OR REPLACE FUNCTION operator_invite(
  p_email text,
  p_business uuid,
  p_role membership_role,
  p_invited_by uuid
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  addr text := lower(btrim(p_email));
  expires timestamptz := now() + interval '7 days';
BEGIN
  IF addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'not an email address' USING ERRCODE = 'check_violation';
  END IF;
  IF p_role IN ('member', 'staff') THEN
    RAISE EXCEPTION 'not a role an operator invites to' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = p_business AND type = 'client' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'not a live client business' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_invited_by AND deleted_at IS NULL AND NOT is_service) THEN
    RAISE EXCEPTION 'unknown inviter' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE invitations SET revoked_at = now()
   WHERE email = addr AND organization_id = p_business
     AND accepted_at IS NULL AND revoked_at IS NULL;
  INSERT INTO invitations (email, organization_id, role, invited_by, expires_at)
  VALUES (addr, p_business, p_role, p_invited_by, expires);
  RETURN expires;
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION operator_open_bindings(), operator_decide_binding(uuid, boolean, text),
  operator_client_businesses(), operator_invite(text, uuid, membership_role, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_open_bindings(), operator_decide_binding(uuid, boolean, text),
  operator_client_businesses(), operator_invite(text, uuid, membership_role, uuid) TO portal_auth;
