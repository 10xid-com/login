-- 0046: 0045's new memberships are recorded as created, not changed.
--
-- 0045 gave ethan@10xid.com Paolo's roles, writing every one to the company's
-- audit trail as `membership.role_changed`, including the ones it created.
-- The trail's word for a new membership is `membership.created` (0029), and
-- anything reading the trail for new access would miss them. This relabels
-- exactly 0045's rows for memberships that did not exist before ("none ->").
--
-- IDEMPOTENT. A second run finds nothing left to relabel.

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE audit_events
     SET action = 'membership.created'
   WHERE action = 'membership.role_changed'
     AND target LIKE 'ethan@10xid.com: none -> % (migration 0045, as paolo@tboxstudio.com)';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[ethan] % audit entr(y/ies) relabelled membership.created.', v_n;
END
$$;
