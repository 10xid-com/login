-- 0044: Ethan (ethan@10xid.com) is staff, as Paolo is.
--
-- WHY. Ethan runs 10XiD day to day, so Paolo isn't the one person who can see
-- and act across every client business. Ethan's decision as operator, of
-- 2026-10-17 (0043 confirmed his sign-in; OPERATOR_EMAILS lists him).
--
-- WHAT IT DOES. Staff is a membership of the house (an internal company) with
-- the role `staff` (0017, isStaffMembership in lib/auth/policy). This finds
-- the house company Paolo (paolo@tboxstudio.com) holds staff in and gives
-- Ethan's live account the same membership: created if he has none there,
-- changed to `staff` if he has another role. Nothing else changes; his other
-- memberships stay as they are. users.is_staff follows by 0017's trigger.
-- He gets it at his next sign-in: a session's role is decided when it starts.
--
-- SKIPS, never raises: no live account for Ethan, or Paolo holds staff in no
-- house company, or in more than one (a person picks).
--
-- IDEMPOTENT. A second run finds him already staff and writes nothing.

DO $$
DECLARE
  v_ethan  uuid;
  v_orgs   uuid[];
  v_org    uuid;
  v_role   text;
BEGIN
  SELECT u.id INTO v_ethan FROM users u WHERE u.email = 'ethan@10xid.com' AND u.deleted_at IS NULL;
  IF v_ethan IS NULL THEN
    RAISE NOTICE '[staff] SKIPPED — no live account on ethan@10xid.com.';
    RETURN;
  END IF;

  SELECT array_agg(m.organization_id) INTO v_orgs
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    JOIN organizations o ON o.id = m.organization_id
   WHERE u.email = 'paolo@tboxstudio.com' AND u.deleted_at IS NULL
     AND m.role = 'staff' AND o.type = 'internal' AND o.deleted_at IS NULL;
  IF v_orgs IS NULL OR array_length(v_orgs, 1) <> 1 THEN
    RAISE NOTICE '[staff] SKIPPED — Paolo is staff in % house companies, not exactly one.', coalesce(array_length(v_orgs, 1), 0);
    RETURN;
  END IF;
  v_org := v_orgs[1];

  SELECT m.role::text INTO v_role FROM memberships m WHERE m.user_id = v_ethan AND m.organization_id = v_org;
  IF v_role = 'staff' THEN
    RAISE NOTICE '[staff] already present  ethan@10xid.com is staff. Nothing written.';
  ELSIF v_role IS NULL THEN
    INSERT INTO memberships (user_id, organization_id, role) VALUES (v_ethan, v_org, 'staff');
    RAISE NOTICE '[staff] CREATED  ethan@10xid.com → staff of the house';
  ELSE
    UPDATE memberships SET role = 'staff', updated_at = now() WHERE user_id = v_ethan AND organization_id = v_org;
    RAISE NOTICE '[staff] CHANGED  ethan@10xid.com % → staff of the house', v_role;
  END IF;
END
$$;
