import "server-only";
import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, inAuthenticationTransaction } from "./connection";
import { identityBindings, invitations, sessions, users } from "./schema";
import { findUserByEmail } from "./identity";

/**
 * Sign-in identity (Better Auth) → portal account (users), as portal_app.
 *
 * Like lib/db/identity.ts these are not tenant-scoped: they are what PRODUCES a
 * scope. `users` and `identity_bindings` carry no organization id. The one
 * read of `invitations` goes through the narrow authentication policy (0007),
 * SELECT only, by exact address.
 */

/** Trimmed and lowercased, nothing more (the build brief's recommendation). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The live, human account bound to this sign-in identity, if any. */
export async function userByAuthUserId(authUserId: string) {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.authUserId, authUserId),
        isNull(users.deletedAt),
        eq(users.isService, false),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Whether any of these addresses belongs to a live account already bound to a sign-in. */
export async function boundAccountAmong(emails: string[]): Promise<boolean> {
  if (emails.length === 0) return false;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.email, emails.map(normalizeEmail)),
        isNotNull(users.authUserId),
        isNull(users.deletedAt),
        eq(users.isService, false),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The binding request still waiting for an operator, for this identity. */
export async function openBindingForAuthUser(authUserId: string) {
  const rows = await db
    .select()
    .from(identityBindings)
    .where(
      and(eq(identityBindings.authUserId, authUserId), isNull(identityBindings.decision)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Ask an operator to tie an existing account to a sign-in identity. One open
 * request per account and per identity (partial unique indexes), so signing
 * in again finds the request already there.
 */
export async function requestAuthBinding(input: {
  userId: string;
  authUserId: string;
  email: string;
}): Promise<void> {
  await db
    .insert(identityBindings)
    .values({
      userId: input.userId,
      authUserId: input.authUserId,
      email: normalizeEmail(input.email),
    })
    .onConflictDoNothing();
}

/**
 * May this address have a sign-in identity created for it at all?
 *
 * Only if somebody let it in: a live invitation made out to exactly this
 * address, or an existing human account that holds it. Anybody else is
 * refused before an identity exists, so the sign-in tables do not fill with
 * strangers. Being admitted here grants nothing — access still needs the
 * authenticator, a verified address, and then an invitation accepted or an
 * operator's confirmation.
 */
export async function mayCreateSignIn(emailRaw: string): Promise<boolean> {
  const email = normalizeEmail(emailRaw);
  const existing = await findUserByEmail(email);
  if (existing) return !existing.isService;

  const live = await inAuthenticationTransaction((tx) =>
    tx
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1),
  );
  return live.length > 0;
}

/**
 * End the portal sessions handed over from one sign-in session, or from every
 * sign-in session of one account. The portal would find them dead on its next
 * request anyway (auth_session_touch); this makes it immediate.
 */
export async function revokePortalSessionsFromAuthSession(authSessionId: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.sourceAuthSessionId, authSessionId), isNull(sessions.revokedAt)));
}

export async function revokePortalSessionsForUser(userId: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
