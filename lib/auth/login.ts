import "server-only";
import { headers } from "next/headers";
import { and, desc, eq } from "drizzle-orm";
import { symmetricDecrypt } from "better-auth/crypto";
import { authDb } from "@/lib/db/auth-connection";
import { authSessions, authTwoFactors } from "@/lib/db/schema";
import { findUserByEmail } from "@/lib/db/identity";
import { acceptInvitation, liveInvitationFor } from "@/lib/db/invitations";
import {
  normalizeEmail,
  openBindingForAuthUser,
  requestAuthBinding,
  userByAuthUserId,
} from "@/lib/db/accounts";
import { getAuth, loginOrigin } from "./auth";
import { safePath } from "./sso";

/**
 * The login host's view of who is signing in, for its pages, server actions
 * and the handoff. Every state-changing step is a POST (a server action);
 * pages only read.
 */

export type LoginIdentity = {
  sessionId: string;
  token: string;
  mfaVerifiedAt: Date | null;
  createdAt: Date;
  user: { id: string; email: string; emailVerified: boolean; name: string };
};

/** The current Better Auth session, if any. Idle or expired sessions are invisible (0022). */
export async function getLoginSession(): Promise<LoginIdentity | null> {
  const result = await getAuth().api.getSession({ headers: await headers() });
  if (!result) return null;
  const session = result.session as typeof result.session & { mfaVerifiedAt?: Date | null };
  return {
    sessionId: session.id,
    token: session.token,
    mfaVerifiedAt: session.mfaVerifiedAt ? new Date(session.mfaVerifiedAt) : null,
    createdAt: new Date(session.createdAt),
    user: {
      id: result.user.id,
      email: result.user.email,
      emailVerified: result.user.emailVerified,
      name: result.user.name,
    },
  };
}

/**
 * Where the authenticator stands for one identity: none, set up but not yet
 * confirmed (with the secret, so the setup page can show it), or confirmed.
 */
export async function authenticatorState(
  authUserId: string,
): Promise<{ state: "none" } | { state: "pending"; secret: string } | { state: "enrolled"; recoveryCodesLeft: number }> {
  const [factor] = await authDb()
    .select()
    .from(authTwoFactors)
    .where(eq(authTwoFactors.userId, authUserId))
    .limit(1);
  if (!factor) return { state: "none" };
  const { secretConfig } = await getAuth().$context;
  if (!factor.verified) {
    return { state: "pending", secret: await symmetricDecrypt({ key: secretConfig, data: factor.secret }) };
  }
  const codes = JSON.parse(await symmetricDecrypt({ key: secretConfig, data: factor.backupCodes })) as string[];
  return { state: "enrolled", recoveryCodesLeft: codes.length };
}

export async function hasConfirmedAuthenticator(authUserId: string): Promise<boolean> {
  const rows = await authDb()
    .select({ id: authTwoFactors.id })
    .from(authTwoFactors)
    .where(and(eq(authTwoFactors.userId, authUserId), eq(authTwoFactors.verified, true)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Login CSRF is the attack to stop here: a page elsewhere posting a sign-in
 * form with the attacker's credentials, so the victim's browser ends up inside
 * the attacker's account. Next.js already compares Origin with Host for server
 * actions; this pins it to exactly the login host's origin as well.
 */
export async function assertLoginOrigin(): Promise<void> {
  const origin = (await headers()).get("origin");
  if (!origin || origin === "null" || origin !== loginOrigin()) {
    throw new Error("This request did not come from the 10XiD sign-in page.");
  }
}

/* ------------------------------------------------------------------ */
/* Sign-in identity → portal account                                   */
/* ------------------------------------------------------------------ */

/**
 * What a completed sign-in (identity + authenticator) means locally.
 *
 *   bound                 the identity already names an account.
 *   invitation_accepted   no account yet, and a live invitation is made out to
 *                         exactly this VERIFIED address: the account is created,
 *                         bound, with that invitation's business and role.
 *   binding_requested     an account from before holds this verified address.
 *                         It is NOT bound here — an operator confirms first,
 *                         because a matching address alone never grants access.
 *   conflict              that account is already bound to another identity.
 *   unverified            the address is not verified, so it proves nothing yet.
 *   no_access             none of the above.
 *
 * Writes, so it is only ever called from a POST, after the authenticator.
 */
export type AccountOutcome =
  | "bound"
  | "invitation_accepted"
  | "binding_requested"
  | "conflict"
  | "unverified"
  | "no_access";

export async function resolveAccount(identity: LoginIdentity["user"]): Promise<AccountOutcome> {
  if (await userByAuthUserId(identity.id)) return "bound";
  if (!identity.emailVerified) return "unverified";

  const email = normalizeEmail(identity.email);
  const existing = await findUserByEmail(email);
  if (existing) {
    if (existing.isService) return "no_access";
    if (existing.authUserId) return "conflict";
    await requestAuthBinding({ userId: existing.id, authUserId: identity.id, email });
    return "binding_requested";
  }

  const invitation = await liveInvitationFor(email);
  if (invitation) {
    const accepted = await acceptInvitation({
      invitationId: invitation.id,
      organizationId: invitation.organizationId,
      email,
      role: invitation.role,
      authUserId: identity.id,
    });
    return accepted ? "invitation_accepted" : "no_access";
  }

  return "no_access";
}

/** The same question, read-only, for pages. */
export async function accountStatus(
  identity: LoginIdentity["user"],
): Promise<"bound" | "pending_binding" | "unverified" | "unresolved"> {
  if (await userByAuthUserId(identity.id)) return "bound";
  if (!identity.emailVerified) return "unverified";
  if (await openBindingForAuthUser(identity.id)) return "pending_binding";
  return "unresolved";
}

/**
 * Where to go once signing in is finished. Only a path on THIS host, and only
 * one of the two places sign-in can be resuming: a handoff to the portal, or
 * the account page. Anything else becomes "/", which sends the person to the
 * portal by the ordinary handoff.
 */
export function safeNext(input: unknown): string {
  const path = safePath(input);
  if (path.startsWith("/auth/sso/authorize?") || path === "/auth/account") return path;
  return "/";
}

/** `?next=` for a link, empty when it is just "/". */
export function nextQuery(next: string, prefix = "?"): string {
  return next === "/" ? "" : `${prefix}next=${encodeURIComponent(next)}`;
}

/**
 * This identity's live sign-in sessions, newest first, read directly.
 *
 * Not through Better Auth's listSessions: that endpoint demands a session
 * created within `freshAge` (ten minutes here, which is right for the
 * sensitive actions that share the setting), so the account page and the
 * sign-out buttons failed for anybody signed in longer than that. The table's
 * row-level security already hides every session that is expired, idle 48
 * hours, or past its seven days (0022), so what this returns is what is live.
 */
export async function ownSignInSessions(userId: string) {
  return authDb()
    .select({
      id: authSessions.id,
      token: authSessions.token,
      userAgent: authSessions.userAgent,
      createdAt: authSessions.createdAt,
    })
    .from(authSessions)
    .where(eq(authSessions.userId, userId))
    .orderBy(desc(authSessions.createdAt));
}
