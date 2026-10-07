-- 0024: the permission matrix's two database halves.
--
-- The matrix itself (which role template may do which action) is application
-- data, in app/lib/auth/permissions.ts. Two of its rules belong here instead,
-- because they are about rows rather than requests:
--
--   1. Legacy `member` memberships in client businesses become `viewer`.
--      `member` predates the six templates and carries no action, so these
--      people could sign in and see nothing. Paolo's decision of 2026-10-07:
--      they read, and nothing more, until an owner or manager says otherwise.
--      Left alone: service accounts (an API key's integration user is a
--      system, not a person, and is managed from the Keys screen), and
--      memberships of the house, where `member` still means "here, not staff"
--      and grants nothing in any case (the portal only authorizes in client
--      businesses). Outstanding invitations to `member` follow the same rule.
--
--   2. A client business can never be left without an owner by the portal.
--      Removing an owner's membership, or changing it to another role, is
--      refused when no other owner would remain. The portal checks this
--      before it tries (app/team/actions.ts); this trigger is what makes it
--      true when two owners remove each other at the same moment, or when a
--      future screen forgets to check.
--
-- The guard applies to the application roles (portal_app, portal_auth). The
-- table owner — migrations, an operator at a terminal, test fixtures — is not
-- the portal, holds every privilege on this table anyway (it could drop the
-- trigger), and must still be able to retire a business outright.
--
-- Additive apart from the data change in (1), which is reported with a count.

DO $$
DECLARE
  v_memberships integer;
  v_invitations integer;
BEGIN
  UPDATE memberships m
     SET role = 'viewer', updated_at = now()
    FROM organizations o, users u
   WHERE o.id = m.organization_id
     AND u.id = m.user_id
     AND m.role = 'member'
     AND o.type = 'client'
     AND NOT u.is_service;
  GET DIAGNOSTICS v_memberships = ROW_COUNT;

  UPDATE invitations i
     SET role = 'viewer'
    FROM organizations o
   WHERE o.id = i.organization_id
     AND i.role = 'member'
     AND o.type = 'client'
     AND i.accepted_at IS NULL
     AND i.revoked_at IS NULL;
  GET DIAGNOSTICS v_invitations = ROW_COUNT;

  RAISE NOTICE '[0024] % member membership(s) and % open invitation(s) in client businesses are now viewer.',
    v_memberships, v_invitations;
END
$$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION memberships_keep_an_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining integer;
BEGIN
  -- Only an owner leaving their business can orphan it.
  IF OLD.role <> 'owner' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.role = 'owner'
     AND NEW.organization_id = OLD.organization_id THEN
    RETURN NULL;
  END IF;

  -- session_user, not current_user: inside this SECURITY DEFINER function
  -- current_user is the table owner whoever called.
  IF session_user NOT IN ('portal_app', 'portal_auth') THEN
    RETURN NULL;
  END IF;

  -- A business that is gone, or is the house, has nobody to protect.
  IF NOT EXISTS (
    SELECT 1 FROM organizations o
     WHERE o.id = OLD.organization_id
       AND o.type = 'client'
       AND o.deleted_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  -- One change to a business's owners at a time. Without this, two owners
  -- removing each other concurrently would each still see the other and both
  -- succeed. The lock is held to the end of the transaction, and the count
  -- below takes a fresh snapshot after acquiring it, so the second sees the
  -- first's committed change.
  PERFORM pg_advisory_xact_lock(hashtextextended('memberships_owner:' || OLD.organization_id::text, 0));

  SELECT count(*) INTO v_remaining
    FROM memberships m
    JOIN users u ON u.id = m.user_id
   WHERE m.organization_id = OLD.organization_id
     AND m.role = 'owner'
     AND u.deleted_at IS NULL
     AND NOT u.is_service;

  IF v_remaining = 0 THEN
    RAISE EXCEPTION 'A business must keep at least one owner.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'memberships_last_owner';
  END IF;

  RETURN NULL;
END
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION memberships_keep_an_owner() FROM PUBLIC;

--> statement-breakpoint

DROP TRIGGER IF EXISTS memberships_keep_an_owner ON memberships;

--> statement-breakpoint

CREATE TRIGGER memberships_keep_an_owner
  AFTER UPDATE OF role, organization_id OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_keep_an_owner();
