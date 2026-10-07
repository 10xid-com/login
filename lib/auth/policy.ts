import type { MembershipRole } from "@/lib/db/schema";

/**
 * Browsers cap every cookie at 400 days regardless of what the server asks for,
 * so no configuration above this is real. Liveness is decided from the session
 * row, never from the cookie's own expiry, because a browser can keep sending an
 * expired cookie indefinitely — but the reverse holds too: past this point the
 * browser stops sending the cookie whatever the row says, so a session that
 * claimed to last longer would only be pretending.
 */
export const MAX_COOKIE_SECONDS = 400 * 24 * 60 * 60;

/**
 * Session policy.
 *
 * Two clocks, both enforced on the server:
 *
 *   idleSeconds       restarts on every visit. Null means no idle timeout.
 *   absoluteSeconds   renewal can never push past it.
 *
 * Both are switched off. A session lasts until it is signed out — asked for
 * directly, and the right call for a portal people open a handful of times a
 * year: an expiry they did not ask for is indistinguishable from the thing
 * being broken, and it recreates the "can you let me back in" support burden
 * this exists to remove. 400 days is not a policy, it is the browser's own
 * ceiling; the row and the cookie lapse together rather than the row outliving
 * a cookie nobody is sending any more.
 *
 * The cost, stated plainly: a stolen session cookie now works until somebody
 * notices and ends it, where a staff one previously died within 8 hours on its
 * own. What still bounds it is not the clock:
 *
 *   * Staff reach ONE client at a time, through a grant that carries a typed
 *     reason and lapses after 30 minutes. An endless session does not become
 *     endless access to every client — STAFF_GRANT_SECONDS below is what
 *     governs that, and it is deliberately untouched.
 *   * Sessions live server-side and are revoked from the Sessions screen,
 *     taking effect on the very next request rather than whenever a token
 *     would have expired.
 *   * Staff still pass a second factor to establish a session at all.
 *
 * These values are COPIED ONTO THE SESSION ROW when it is created. Promoting
 * someone to staff tomorrow must not retroactively stretch a session that is
 * already live, and demoting them must not silently extend one either. That
 * also means this change reaches a session only when it is next created: one
 * more sign-in, and then not again.
 */

export type SessionRole = "client" | "staff";

export const SESSION_POLICY: Record<
  SessionRole,
  { idleSeconds: number | null; absoluteSeconds: number }
> = {
  client: {
    idleSeconds: null,
    absoluteSeconds: MAX_COOKIE_SECONDS,
  },
  staff: {
    idleSeconds: null,
    absoluteSeconds: MAX_COOKIE_SECONDS,
  },
};

/** Sign-in codes are short-lived and few. */
export const SIGN_IN_CODE = {
  ttlSeconds: 10 * 60,
  maxAttempts: 5,
  /** Requests for a new code, per address, per window. */
  maxRequestsPerWindow: 5,
  requestWindowSeconds: 15 * 60,
};

/**
 * The cross-domain ticket is measured in seconds because it only has to survive
 * one redirect. Anything longer is a credential sitting in a browser's history.
 */
export const SSO_TICKET_TTL_SECONDS = 30;

/**
 * A staff grant covers one client for one working stretch, then lapses.
 *
 * This is the clock that matters now that sessions have none. Staying signed in
 * is convenience; reaching a particular client's data is the privilege, and it
 * stays bounded, still needs a reason typed at the moment of switching, and
 * still has to be asked for again afterwards.
 */
export const STAFF_GRANT_SECONDS = 30 * 60;

/**
 * Acting as somebody else: one hour, then it stops.
 *
 * Twice the staff-to-client grant above, and for a different reason. Opening a
 * client is a look at a list; being somebody is doing their work, and half an
 * hour is short enough that the clock, rather than the task, decides when you
 * stop. An hour is long enough to walk a whole job through Flow from one
 * person's side and short enough that a browser left open over lunch is not
 * still somebody else at three o'clock.
 *
 * It is not extended in place. Renewal writes a NEW grant, with its own reason
 * and its own hour, so the record says "he was Joel again at 15:40, because —"
 * rather than showing one row that quietly grew.
 */
export const ACT_AS_GRANT_SECONDS = 60 * 60;

/**
 * The floor on a typed reason, shared with the staff-to-client grant.
 *
 * Eight characters does not make a reason good. It makes "." impossible, which
 * is the whole of what a minimum can do — the value of the field is that
 * somebody had to put words to what they were about to do while they were
 * doing it.
 */
export const GRANT_REASON_MIN = 8;
export const GRANT_REASON_MAX = 200;

/**
 * The capability that permits acting as a STAFF account.
 *
 * Acting as a client is bounded by what that client can see: one company, their
 * own jobs. Acting as a colleague who is themselves staff is not bounded by
 * anything, so it is the one target that needs more than a staff session.
 *
 * It is a CAPABILITY rather than a hard-coded rule because "Paolo may act as
 * anyone, staff included, until further notice" is exactly a permission row:
 * granted deliberately, revocable in one statement, visible in the same table
 * as everything else somebody may do. A constant in the source that named him
 * would need a deploy to withdraw, which is not what "until further notice"
 * means.
 *
 * Checked against the REAL actor, in an INTERNAL organization — the house, not
 * a client. A client company must not be able to hand out power over staff by
 * granting a capability inside its own walls.
 */
export const ACT_AS_STAFF_CAPABILITY = "user.act_as.staff";

/**
 * What one API key may file, per hour.
 *
 * A client's contact form is the thing on the other end, so this is sized for a
 * busy day rather than for a machine: sixty an hour is far more than any real
 * form produces and far less than a script pointed at the endpoint would. The
 * count comes from the database rather than from memory, because the
 * application runs as more than one instance.
 */
export const API_KEY_RATE = {
  maxJobsPerWindow: 60,
  windowSeconds: 60 * 60,
};

/**
 * WHAT MAKES A SESSION STAFF.
 *
 * Membership of the internal company used to be the whole of it:
 *
 *   const role = mships.some((m) => m.organizationType === "internal")
 *     ? "staff" : "client";
 *
 * which meant anybody added to the house — a bookkeeper, a summer student, an
 * account created to test something — silently held authority over every
 * client's data. The `staff` value in the membership_role enum existed and
 * meant nothing, so the field that looks like it answers this question did not.
 * 0013 found the live proof: an administrator who does the books held a staff
 * session, because he is in the house, though his membership says `member`.
 *
 * The rule now takes BOTH halves, and both are load-bearing:
 *
 *   organizationType === "internal"   the company is the house, not a client.
 *                                     A client company must never be able to
 *                                     mint authority over other clients by
 *                                     handing out a role inside its own walls.
 *   role === "staff"                   this person is here to work on clients'
 *                                     behalf, rather than merely being here.
 *
 * Neither alone is enough, which is why this is one function rather than two
 * predicates spelled out at each call site. It is pure, takes the memberships
 * as data, and lives in this file rather than beside the session so that the
 * four cases it decides can be pinned by tests without a cookie, a database or
 * a request: internal+staff is staff; internal+member is not; client+staff is
 * not; no membership is not.
 *
 * Widening it is deliberately awkward. Somebody who should be staff is given a
 * staff-role membership of the house — one row, in the table that already says
 * who is who — and never by being added to a company.
 */
export type RoleDerivationMembership = {
  organizationType: "client" | "internal";
  role: MembershipRole;
};

/** True for the one membership shape that confers staff: the house, as staff. */
export function isStaffMembership(m: RoleDerivationMembership): boolean {
  return m.organizationType === "internal" && m.role === "staff";
}

/**
 * The session role somebody's memberships add up to.
 *
 * Used by startSession() when a session is created and by getSessionContext()
 * when an act-as grant makes the effective person somebody else. The same
 * function in both places on purpose: two copies of an authentication rule is
 * one copy that eventually gets fixed alone.
 */
export function sessionRoleFor(
  memberships: readonly RoleDerivationMembership[],
): SessionRole {
  return memberships.some(isStaffMembership) ? "staff" : "client";
}
