import "server-only";
import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import {
  activeSessionsForUser,
  consumeTicketsForSession,
  endActAsGrantsForSession,
  insertSession,
  liveActAsGrantForSession,
  liveGrantForSession,
  membershipsForUser,
  revokeAllSessionsForUser,
  revokeSession,
  sessionByTokenHash,
  touchSession,
  userById,
} from "@/lib/db/identity";
import type { Scope } from "@/lib/db";
import { secretToken } from "@/lib/ids";
import {
  MAX_COOKIE_SECONDS,
  SESSION_POLICY,
  sessionRoleFor,
  type SessionRole,
} from "./policy";

/**
 * The session cookie carries a random value and nothing else. It is a lookup
 * key, never a claim — there is no role, no company and no expiry inside it
 * that a caller could tamper with, and only its hash is stored, so reading the
 * database yields no usable session.
 */

const SECURE = process.env.SESSION_COOKIE_SECURE !== "false";

/**
 * The `__Host-` prefix is enforced by the browser itself: a cookie carrying it
 * must be Secure, must have Path=/, and must have NO Domain attribute. That
 * last part is the valuable one — it makes the cookie unable to be set for this
 * host by any sibling subdomain, which removes a whole class of attack for
 * free. It requires a secure context, so plain-HTTP local development falls
 * back to an unprefixed name; every deployed environment gets the prefix.
 */
export const SESSION_COOKIE = SECURE
  ? "__Host-portal_session"
  : "portal_session";

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Who a request is FROM, and who it is BY.
 *
 * Almost always the same person, and then this reads exactly as it used to.
 * While a live act-as grant is held they differ, and the difference is the
 * whole security boundary of that feature:
 *
 *   userId / email / fullName / role / memberships / scope
 *       the EFFECTIVE identity — the person being appeared as. Every screen
 *       and every query reads these, which is what makes "see what they see"
 *       true rather than approximately true: there is no second rendering
 *       path, and therefore no second set of bugs.
 *
 *   realUserId / realEmail / realIsStaff
 *       the human at the keyboard. Every PERMISSION is decided from these.
 *       Reading staff-ness off the effective identity would mean a staff
 *       session that had become a client had genuinely stopped being staff —
 *       convenient for exactly one thing, which is escaping its own rules.
 *
 *   actingAs
 *       null or the live grant. Null is what the banner, the guards and the
 *       audit all key off, so "is this real work?" has one answer in one
 *       place.
 */
export type SessionContext = {
  sessionId: string;
  /** The EFFECTIVE person: the target while acting as, otherwise the real one. */
  userId: string;
  email: string;
  fullName: string | null;
  role: SessionRole;
  scope: Scope;
  memberships: Awaited<ReturnType<typeof membershipsForUser>>;
  absoluteExpiresAt: Date;
  idleSeconds: number | null;
  /** When this session cleared its second factor, if it has. */
  secondFactorAt: Date | null;
  /** True for a staff session that has passed the email code and nothing else. */
  needsSecondFactor: boolean;
  /** The human this session belongs to. Equal to userId unless acting as. */
  realUserId: string;
  realEmail: string;
  /** Staff-ness of the REAL person. Never taken from the effective identity. */
  realIsStaff: boolean;
  /** The live act-as grant, or null. Null means this is the person's own work. */
  actingAs: {
    grantId: string;
    userId: string;
    email: string;
    fullName: string | null;
    reason: string;
    startedAt: Date;
    expiresAt: Date;
  } | null;
};

/** Which host this request arrived on. Used for cookies and branding only. */
export async function currentHost(): Promise<string> {
  const h = await headers();
  return (h.get("host") ?? "").toLowerCase();
}

/**
 * Establish a session for someone who has just proved who they are.
 *
 * The role is read from their memberships, never from anything the caller sent.
 * Both clocks are resolved here and written onto the row, so the session's
 * limits are fixed at the moment it is created.
 */
export async function startSession(input: {
  userId: string;
  host: string;
  /**
   * True when the thing that was just checked WAS the second factor — an
   * authenticator code, or a recovery code standing in for one. Such a session
   * starts already cleared, because sending it to the enrolment screen would be
   * asking for the same code twice in a row.
   *
   * It is passed in by the caller that did the checking rather than inferred
   * here, so there is no way for this function to assume a factor was presented
   * when it was not.
   */
  secondFactorPassed?: boolean;
  /**
   * The login-host session that handed this browser over, when this session is
   * the far end of a handoff. Recorded so the two are known to be one device.
   */
  sourceSessionId?: string;
}): Promise<{ token: string; sessionId: string; role: SessionRole }> {
  const mships = await membershipsForUser(input.userId);
  /**
   * Staff-ness comes from sessionRoleFor(), which wants BOTH halves: the
   * company is the house, AND the membership role is `staff`. Being added to
   * the internal company is no longer enough, because it never should have
   * been — it made a bookkeeper an authority over every client's data, and the
   * `staff` value in the enum that looks like it answers this meant nothing.
   */
  const role: SessionRole = sessionRoleFor(mships);

  const policy = SESSION_POLICY[role];
  const token = secretToken(32);

  // A client belonging to exactly one company is scoped to it immediately.
  // Staff start unscoped: they must choose a client and give a reason.
  const clientOrgs = mships.filter((m) => m.organizationType === "client");
  const activeOrganizationId =
    role === "client" && clientOrgs.length === 1
      ? clientOrgs[0].organizationId
      : null;

  const session = await insertSession({
    userId: input.userId,
    tokenHash: hashToken(token),
    issuedForHost: input.host.toLowerCase(),
    idleSeconds: policy.idleSeconds,
    absoluteExpiresAt: new Date(Date.now() + policy.absoluteSeconds * 1000),
    roleAtCreation: role,
    activeOrganizationId,
    secondFactorAt: input.secondFactorPassed ? new Date() : null,
    sourceSessionId: input.sourceSessionId ?? null,
  });

  return { token, sessionId: session.id, role };
}

export async function writeSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  const maxAge = Math.max(
    0,
    Math.min(
      MAX_COOKIE_SECONDS,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    ),
  );
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Lax, not Strict: Strict means arriving from a link in a notification
    // email lands you signed out until you reload, which is exactly the
    // "it randomly logs me out" experience this design exists to avoid.
    sameSite: "lax",
    secure: SECURE,
    path: "/",
    maxAge,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: SECURE,
    path: "/",
    maxAge: 0,
  });
}

/**
 * Resolve the current session, enforcing both clocks.
 *
 * Liveness comes from the database row, never from the cookie — a browser can
 * keep sending a cookie long after it was supposed to lapse, so the cookie's
 * own expiry is a convenience for the browser and nothing more.
 */
export async function getSessionContext(): Promise<SessionContext | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await sessionByTokenHash(hashToken(token));
  if (!session) return null;

  const now = Date.now();

  // Absolute cap: renewal can never push past it.
  if (session.absoluteExpiresAt.getTime() <= now) {
    await revokeSession(session.id);
    return null;
  }

  // Idle clock: restarts on every visit, when the role has one at all.
  if (session.idleSeconds !== null) {
    const idleDeadline =
      session.lastSeenAt.getTime() + session.idleSeconds * 1000;
    if (idleDeadline <= now) {
      await revokeSession(session.id);
      return null;
    }
  }

  const user = await userById(session.userId);
  if (!user) {
    await revokeSession(session.id);
    return null;
  }

  await touchSession(session.id);

  const roleAtCreation = session.roleAtCreation as SessionRole;

  /**
   * A staff session that has not cleared its second factor carries no
   * authority at all.
   *
   * The redirect to the enrolment screen is the visible half; this is the half
   * that matters. Even if some route forgets to redirect, the scope it receives
   * is not staff and is bound to no client, so it can read nothing — the check
   * is in what the session grants, not only in where it is sent.
   */
  const needsSecondFactor =
    roleAtCreation === "staff" && session.secondFactorAt === null;
  const realIsStaff = roleAtCreation === "staff" && !needsSecondFactor;

  /**
   * Is this session currently somebody else?
   *
   * Looked up on every request rather than stamped on the session row, which
   * is what makes the hour real: the grant stops being live on its own, and
   * the very next page is the person themselves again with nothing to clean
   * up. Only a session that is really staff is asked the question at all.
   */
  const actGrant = realIsStaff ? await liveActAsGrantForSession(session.id) : null;
  const target = actGrant ? await userById(actGrant.targetUserId) : null;

  // A live grant on an account that has since been deleted. End it rather than
  // silently continuing as somebody — a banner that is not shown while an
  // identity is still in force is the exact failure this feature must not have.
  if (actGrant && !target) {
    await endActAsGrantsForSession(session.id);
  }

  const acting = actGrant && target ? { grant: actGrant, target } : null;
  const effective = acting ? acting.target : user;

  const mships = await membershipsForUser(effective.id);

  /**
   * The effective role is derived from the EFFECTIVE person's memberships, by
   * the same rule startSession() uses — the one function, so that the two
   * cannot drift apart. Acting as a client therefore really is a client
   * session, with a client's reach, which is the point.
   *
   * Not acting, the role is the one stamped on the session row at creation.
   * That is unchanged and deliberate: a session carries the policy it was
   * created under. It also means this change reaches a live session only when
   * it is next created — someone who is signed in now keeps the role they
   * signed in with until they sign in again.
   */
  const role: SessionRole = acting ? sessionRoleFor(mships) : roleAtCreation;

  const isStaff = role === "staff" && !needsSecondFactor;

  /**
   * Which company's rows are on screen.
   *
   * Not acting: unchanged — a client is scoped to the company stamped on their
   * session, and staff to whatever client their live staff grant covers, so
   * that access lapses on its own.
   *
   * Acting as a CLIENT: their own company, resolved the way startSession()
   * resolves it for them — one company, or none if they hold none or several,
   * which is precisely what they would see on signing in.
   *
   * Acting as STAFF: null, the cross-client survey. The staff grant held by
   * the real session deliberately does NOT carry over. A staff grant is an
   * audit row naming one person who opened one client, and it has one identity
   * column; borrowing somebody else's while wearing their name would put the
   * wrong name in that record. So opening a client is one of the things that
   * waits until you are yourself again.
   */
  let organizationId: string | null = null;
  if (acting) {
    const clientOrgs = mships.filter((m) => m.organizationType === "client");
    organizationId =
      role === "client" && clientOrgs.length === 1
        ? clientOrgs[0].organizationId
        : null;
  } else {
    organizationId = needsSecondFactor ? null : session.activeOrganizationId;
    if (isStaff) {
      const grant = await liveGrantForSession(session.id);
      organizationId = grant?.organizationId ?? null;
    }
  }

  return {
    sessionId: session.id,
    userId: effective.id,
    email: effective.email,
    fullName: effective.fullName,
    role,
    scope: {
      userId: effective.id,
      email: effective.email,
      isStaff,
      organizationId,
      /**
       * Carried into every write so the audit can name both people. Null on an
       * ordinary session, which is what makes null mean "this was real work".
       */
      actingAs: acting
        ? {
            grantId: acting.grant.id,
            realUserId: user.id,
            realEmail: user.email,
          }
        : null,
    },
    memberships: mships,
    absoluteExpiresAt: session.absoluteExpiresAt,
    idleSeconds: session.idleSeconds,
    secondFactorAt: session.secondFactorAt,
    needsSecondFactor,
    realUserId: user.id,
    realEmail: user.email,
    realIsStaff,
    actingAs: acting
      ? {
          grantId: acting.grant.id,
          userId: acting.target.id,
          email: acting.target.email,
          fullName: acting.target.fullName,
          reason: acting.grant.reason,
          startedAt: acting.grant.startedAt,
          expiresAt: acting.grant.expiresAt,
        }
      : null,
  };
}

/**
 * Sign out everywhere, immediately.
 *
 * Every domain holds its own cookie and we cannot reach across to delete them —
 * but a cookie is only a key, and every row it could point at is now revoked.
 * The next request from any domain finds nothing. There is no window during
 * which a previously issued token still works, which is the trade a
 * short-lived-token design makes and this one does not.
 */
export async function signOutEverywhere(userId: string, sessionId: string) {
  await consumeTicketsForSession(sessionId);
  const count = await revokeAllSessionsForUser(userId);
  await clearSessionCookie();
  return count;
}

export async function signOutThisSession(sessionId: string) {
  await consumeTicketsForSession(sessionId);
  await revokeSession(sessionId);
  await clearSessionCookie();
}

export { activeSessionsForUser };
