import "server-only";
import { and, desc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "./connection";
import {
  actAsGrants,
  identities,
  memberships,
  organizationDomains,
  organizations,
  recoveryCodes,
  sessions,
  signInCodes,
  ssoTickets,
  staffGrants,
  userEmails,
  users,
} from "./schema";

/**
 * Identity queries — who someone is, and what scope their session carries.
 *
 * These are deliberately NOT tenant-scoped, and that is not an exception to the
 * rule. They are what PRODUCES a scope: you cannot look up someone's
 * memberships while already scoped to a company, any more than you can check a
 * passport while already through the gate. Each of these tables is listed in
 * scripts/check-rls.ts with that reasoning written down, so the exemption is a
 * decision on the record rather than an oversight.
 *
 * Nothing here is reachable by an id a caller supplies: sessions and tickets are
 * found by the hash of a secret only the holder has, never enumerated.
 */

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

export async function userById(id: string) {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve an address to the account that holds it.
 *
 * Reads through `user_emails`, not `users.email`, because an account may hold
 * several addresses and any of them should reach the same person. The
 * predicate is the load-bearing part:
 *
 *   the account's PRIMARY address, or a secondary one that has been VERIFIED
 *
 * A secondary address counts only once verified, which closes the obvious
 * abuse: adding somebody else's address to your own account would otherwise
 * let a code sent to their inbox open your session, and — because addresses
 * are globally unique — would also squat the address so its real owner could
 * never claim it.
 *
 * The primary is exempt from that test on purpose. Every account that exists
 * has one, service accounts included (they are never verified because there is
 * no inbox to verify), and requiring verification here would change who
 * resolves at sign-in. This function returns exactly what it returned when the
 * address was a column on `users`.
 */
export async function findUserByEmail(email: string) {
  const rows = await db
    .select()
    .from(users)
    .innerJoin(userEmails, eq(userEmails.userId, users.id))
    .where(
      and(
        eq(userEmails.email, email.toLowerCase()),
        isNull(users.deletedAt),
        or(eq(userEmails.isPrimary, true), isNotNull(userEmails.verifiedAt)),
      ),
    )
    .limit(1);
  return rows[0]?.users ?? null;
}

/** Every address on an account, primary first. */
export async function emailsForUser(userId: string) {
  return db
    .select({
      id: userEmails.id,
      email: userEmails.email,
      isPrimary: userEmails.isPrimary,
      verifiedAt: userEmails.verifiedAt,
      createdAt: userEmails.createdAt,
    })
    .from(userEmails)
    .where(eq(userEmails.userId, userId))
    .orderBy(desc(userEmails.isPrimary), userEmails.createdAt);
}

/**
 * Claim an address for an account, unverified.
 *
 * Unverified is the whole point: until it is confirmed it cannot be signed in
 * with. The unique constraint means a claim on an address already held
 * elsewhere fails outright rather than silently moving it, so this returns null
 * instead of throwing — "somebody already has that" is an ordinary answer, not
 * an exceptional one.
 */
export async function addEmailToAccount(userId: string, emailRaw: string) {
  const rows = await db
    .insert(userEmails)
    .values({ userId, email: emailRaw.trim().toLowerCase(), isPrimary: false })
    .onConflictDoNothing({ target: userEmails.email })
    .returning();
  return rows[0] ?? null;
}

/** Confirm control of an address. Only then can it be signed in with. */
export async function verifyEmail(userId: string, emailRaw: string) {
  const rows = await db
    .update(userEmails)
    .set({ verifiedAt: new Date() })
    .where(
      and(
        eq(userEmails.userId, userId),
        eq(userEmails.email, emailRaw.trim().toLowerCase()),
      ),
    )
    .returning({ id: userEmails.id });
  return rows.length === 1;
}

/**
 * Move the primary flag, and the `users.email` mirror with it.
 *
 * `users.email` is kept as a denormalised copy of the primary address — the
 * same bargain `users.is_staff` already makes in this schema — so that listing
 * a team does not need a join per row. The cost of a denormalisation is that it
 * can drift, so this transaction is the ONLY writer of it. Nothing else may set
 * `users.email`.
 *
 * Refuses an unverified address: promoting one would let an unconfirmed claim
 * become the address the system writes to.
 *
 * One statement clears the old primary and the next sets the new, both inside a
 * transaction, because the partial unique index permits exactly one primary per
 * account and would reject the pair applied in the other order.
 */
export async function setPrimaryEmail(
  userId: string,
  emailRaw: string,
): Promise<boolean> {
  const email = emailRaw.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const candidate = await tx
      .select({ id: userEmails.id, verifiedAt: userEmails.verifiedAt })
      .from(userEmails)
      .where(and(eq(userEmails.userId, userId), eq(userEmails.email, email)))
      .limit(1);
    if (!candidate[0] || candidate[0].verifiedAt === null) return false;

    await tx
      .update(userEmails)
      .set({ isPrimary: false })
      .where(and(eq(userEmails.userId, userId), eq(userEmails.isPrimary, true)));
    await tx
      .update(userEmails)
      .set({ isPrimary: true })
      .where(eq(userEmails.id, candidate[0].id));
    await tx
      .update(users)
      .set({ email, updatedAt: new Date() })
      .where(eq(users.id, userId));
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* The iD                                                              */
/* ------------------------------------------------------------------ */

/**
 * The live iD on an account, if it holds one.
 *
 * Most accounts will not. That is the design — an account is what everybody who
 * signs in anywhere gets, and an iD is a thing issued on top of it.
 */
export async function identityForUser(userId: string) {
  const rows = await db
    .select()
    .from(identities)
    .where(and(eq(identities.userId, userId), isNull(identities.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function identityByCode(idCode: string) {
  const rows = await db
    .select()
    .from(identities)
    .where(eq(identities.idCode, idCode))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Issue an iD.
 *
 * Returns null rather than throwing on either refusal, because both are
 * ordinary answers: the account already holds a live iD (the partial unique
 * index says one at a time), or the code has been used before by anyone, ever,
 * including on a revoked row. Codes are never reissued — the previous holder's
 * history is what a reuse would silently reattribute.
 */
export async function issueIdentity(userId: string, idCode: string) {
  const rows = await db
    .insert(identities)
    .values({ userId, idCode })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

/**
 * Give up an iD.
 *
 * The row stays and is stamped, so "held this code and gave it up" remains a
 * fact — the application role holds no DELETE on this table, so erasing it is a
 * permission error rather than anybody's decision. Nothing else in the schema
 * references the code, so this touches no memberships, no jobs and no audit
 * rows: revoking an iD changes what somebody is called, never what they did.
 */
export async function revokeIdentity(userId: string): Promise<boolean> {
  const rows = await db
    .update(identities)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(identities.userId, userId), isNull(identities.revokedAt)))
    .returning({ id: identities.id });
  return rows.length === 1;
}

export async function setTotpSecret(userId: string, encrypted: string) {
  await db
    .update(users)
    .set({ totpSecret: encrypted, totpConfirmedAt: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function confirmTotp(userId: string) {
  await db
    .update(users)
    .set({ totpConfirmedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/** Records that this session cleared its second factor. */
export async function markSecondFactorPassed(sessionId: string) {
  await db
    .update(sessions)
    .set({ secondFactorAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

export async function markEmailVerified(userId: string) {
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * The companies a person belongs to, and the role they hold in each.
 *
 * Staff are identified by membership of the one internal organization — never
 * by a flag a form could set, and never by which hostname the request arrived
 * on.
 */
export async function membershipsForUser(userId: string) {
  return db
    .select({
      organizationId: memberships.organizationId,
      role: memberships.role,
      organizationName: organizations.name,
      organizationSlug: organizations.slug,
      organizationType: organizations.type,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, userId), isNull(organizations.deletedAt)));
}

/* ------------------------------------------------------------------ */
/* Sign-in codes                                                       */
/* ------------------------------------------------------------------ */

export async function recentCodeRequests(email: string, withinSeconds: number) {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(signInCodes)
    .where(
      and(
        eq(signInCodes.email, email.toLowerCase()),
        gt(
          signInCodes.createdAt,
          new Date(Date.now() - withinSeconds * 1000),
        ),
      ),
    );
  return rows[0]?.n ?? 0;
}

export async function storeSignInCode(input: {
  email: string;
  codeHash: Buffer;
  expiresAt: Date;
  requestedIp: string | null;
}) {
  await db.insert(signInCodes).values({
    email: input.email.toLowerCase(),
    codeHash: input.codeHash,
    expiresAt: input.expiresAt,
    requestedIp: input.requestedIp,
  });
}

/** The most recent unconsumed, unexpired code for this address, if any. */
export async function latestLiveCode(email: string) {
  const rows = await db
    .select()
    .from(signInCodes)
    .where(
      and(
        eq(signInCodes.email, email.toLowerCase()),
        isNull(signInCodes.consumedAt),
        gt(signInCodes.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(signInCodes.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function countCodeAttempt(id: string) {
  await db
    .update(signInCodes)
    .set({ attempts: sql`${signInCodes.attempts} + 1` })
    .where(eq(signInCodes.id, id));
}

/**
 * Single use, enforced by the database rather than by checking first and
 * writing after. The `consumed_at IS NULL` in the WHERE clause means two
 * simultaneous redemptions produce exactly one winner; the loser gets no row
 * back and is rejected.
 */
export async function consumeSignInCode(id: string): Promise<boolean> {
  const rows = await db
    .update(signInCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(signInCodes.id, id), isNull(signInCodes.consumedAt)))
    .returning({ id: signInCodes.id });
  return rows.length === 1;
}

/* ------------------------------------------------------------------ */
/* Recovery codes                                                      */
/* ------------------------------------------------------------------ */

/**
 * Replace the whole set.
 *
 * The old codes are RETIRED, not deleted — marked spent, exactly as if they had
 * been redeemed. Two reasons, and the database enforces the first: the
 * application role holds no DELETE on this table, so erasing history is a
 * permission error rather than a decision anyone can quietly make. The second
 * is that "this code was issued and then superseded" and "this code never
 * existed" are different facts, and only one of them is worth having in an
 * incident.
 *
 * In one transaction, because a half-applied replacement is the worst of both:
 * the old set retired and the new one not yet written is an account with no way
 * back in at all.
 */
export async function replaceRecoveryCodes(
  userId: string,
  hashes: Buffer[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(recoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)),
      );
    if (hashes.length > 0) {
      await tx
        .insert(recoveryCodes)
        .values(hashes.map((codeHash) => ({ userId, codeHash })));
    }
  });
}

/**
 * Spend one, atomically.
 *
 * `used_at IS NULL` in the WHERE clause is what makes it single-use: two
 * simultaneous submissions of the same code produce exactly one winner, and the
 * loser gets no row back. Checking first and updating after would let both in.
 */
export async function consumeRecoveryCode(
  userId: string,
  codeHash: Buffer,
): Promise<boolean> {
  const rows = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(recoveryCodes.userId, userId),
        eq(recoveryCodes.codeHash, codeHash),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .returning({ id: recoveryCodes.id });
  return rows.length === 1;
}

/** How many are left, for the warning on the sessions screen. */
export async function recoveryCodesRemaining(userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return rows[0]?.n ?? 0;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export async function insertSession(input: {
  userId: string;
  tokenHash: Buffer;
  issuedForHost: string;
  idleSeconds: number | null;
  absoluteExpiresAt: Date;
  roleAtCreation: string;
  activeOrganizationId: string | null;
  secondFactorAt: Date | null;
  /** The login-host session this one was handed over from, if any. */
  sourceSessionId?: string | null;
}) {
  const rows = await db.insert(sessions).values(input).returning();
  return rows[0];
}

export async function sessionByTokenHash(tokenHash: Buffer) {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function touchSession(id: string) {
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, id));
}

export async function revokeSession(id: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
}

/**
 * Signing out ends every session this person holds, on every domain.
 *
 * Each domain has its own cookie, so we cannot clear them remotely — but the
 * cookie is only a lookup key, and the row it points at is gone. The next
 * request from any domain finds nothing and is signed out. That is what makes
 * sign-out propagate immediately rather than after a token expires.
 */
export async function revokeAllSessionsForUser(userId: string) {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length;
}

/** Sign out every other device, keeping the one being used right now. */
/**
 * The device a session belongs to, as the id every session of it shares.
 *
 * A session signed in to directly is a device of its own, so its key is its own
 * id; a session the handoff created belongs to the login-host session it came
 * from (see 0020). The lookup is confined to `userId`'s own sessions, so a
 * stranger's id names no device of theirs and falls back to itself, which then
 * matches nothing this person holds.
 */
function deviceOf(userId: string, sessionId: string) {
  return sql`coalesce(
    (select s.source_session_id from sessions s
      where s.id = ${sessionId} and s.user_id = ${userId}),
    ${sessionId}::uuid
  )`;
}

/**
 * Every session on the same device as `sessionId`, this one included.
 *
 * Never NULL: source_session_id is null on every session signed in to
 * directly, and a bare `source_session_id = device` would make the whole
 * condition unknown for those — which `not (...)` then quietly treats as
 * neither on the device nor off it, skipping exactly the sessions a "sign out
 * every other device" is for.
 */
function onDevice(userId: string, sessionId: string) {
  const device = deviceOf(userId, sessionId);
  return sql`(${sessions.id} = ${device} or coalesce(${sessions.sourceSessionId} = ${device}, false))`;
}

/** Sign out every other device: everything except this browser's sessions. */
export async function revokeOtherSessionsForUser(
  userId: string,
  keepSessionId: string,
) {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        sql`not ${onDevice(userId, keepSessionId)}`,
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}

/**
 * Sign out one device, but only if it belongs to this person.
 *
 * The device, not the one session: ending only the portal's session would
 * leave the login host's, and the next page would hand the browser straight
 * back in.
 */
export async function revokeOwnSession(userId: string, sessionId: string) {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        onDevice(userId, sessionId),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length > 0;
}

export async function activeSessionsForUser(userId: string) {
  return db
    .select({
      id: sessions.id,
      issuedForHost: sessions.issuedForHost,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
      roleAtCreation: sessions.roleAtCreation,
      sourceSessionId: sessions.sourceSessionId,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .orderBy(desc(sessions.lastSeenAt));
}

export async function setSessionActiveOrganization(
  sessionId: string,
  organizationId: string | null,
) {
  await db
    .update(sessions)
    .set({ activeOrganizationId: organizationId })
    .where(eq(sessions.id, sessionId));
}

/* ------------------------------------------------------------------ */
/* Staff grants                                                        */
/* ------------------------------------------------------------------ */

/**
 * The people in one company.
 *
 * Takes the organization id explicitly rather than reading it from anywhere
 * ambient, and the caller passes it from the SESSION — memberships are not
 * row-level-security protected (they are what produces a scope), so this is the
 * one place the filter has to be supplied by hand and is worth reading twice.
 */
export async function teamFor(organizationId: string) {
  return db
    .select({
      userId: users.id,
      email: users.email,
      fullName: users.fullName,
      role: memberships.role,
      isStaff: users.isStaff,
      isService: users.isService,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(eq(memberships.organizationId, organizationId), isNull(users.deletedAt)),
    )
    .orderBy(users.fullName);
}

/**
 * The internal organization — the staff side of the exchange. There is meant to
 * be exactly one.
 *
 * This used to take the first row it found, which is a sentence that hides the
 * problem: with more than one candidate, POSTGRES decides which company is the
 * house — by whatever order a seq scan happens to return today — and it can
 * decide differently tomorrow after a VACUUM without one line of code changing.
 * Production really did hold two for a while (0013 found them; 0016 settled
 * it), and during that time app/team/page.tsx showed staff "their" team from
 * whichever row came back first.
 *
 * So it refuses instead. Two rows is a state somebody has to look at — one of
 * them is a client brand that was never retyped, or a second house nobody meant
 * to create — and the honest failure is louder than a page that renders the
 * wrong company's people and says nothing. It reads THREE so the message can
 * say whether there are exactly two or more, and name them; a limit of two
 * would only ever be able to say "at least two".
 *
 * Zero is NOT an error and still returns null. A deployment with no internal
 * company is a portal that has not been set up yet, or one where the house has
 * been retyped deliberately; the callers already handle null, and turning a
 * not-yet-configured install into an exception helps nobody.
 */
export async function internalOrganization() {
  const rows = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.type, "internal"), isNull(organizations.deletedAt)))
    .orderBy(organizations.slug)
    .limit(3);

  if (rows.length > 1) {
    throw new Error(
      `There are ${rows.length === 3 ? "at least 3" : String(rows.length)} ` +
        "organizations of type 'internal' (" +
        rows.map((o) => o.slug).join(", ") +
        "), and this asks for THE internal one. Which company is the house is " +
        "a decision, not a row order: retype the ones that are client brands, " +
        "or delete the duplicate. Refusing rather than picking, because " +
        "picking silently means Postgres chooses and can choose differently " +
        "after a VACUUM.",
    );
  }

  return rows[0] ?? null;
}

/** The client picker staff choose from. Internal organizations are not clients. */
export async function listClientOrganizations() {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      brandPrimaryHex: organizations.brandPrimaryHex,
    })
    .from(organizations)
    .where(and(eq(organizations.type, "client"), isNull(organizations.deletedAt)))
    .orderBy(organizations.name);
}

export async function organizationById(id: string) {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createStaffGrant(input: {
  staffUserId: string;
  organizationId: string;
  reason: string;
  sessionId: string;
  expiresAt: Date;
}) {
  const rows = await db.insert(staffGrants).values(input).returning();
  return rows[0];
}

/**
 * Give up the grant.
 *
 * The row is kept — it is the audit record of which client was opened and why —
 * but its window is closed now rather than left to lapse. Clearing the
 * session's pointer alone would not be enough: the grant is what the scope is
 * derived from, so a live grant would keep the access open.
 */
export async function endGrantsForSession(sessionId: string) {
  await db
    .update(staffGrants)
    .set({ expiresAt: new Date() })
    .where(
      and(
        eq(staffGrants.sessionId, sessionId),
        gt(staffGrants.expiresAt, new Date()),
      ),
    );
}

export async function liveGrantForSession(sessionId: string) {
  const rows = await db
    .select()
    .from(staffGrants)
    .where(
      and(
        eq(staffGrants.sessionId, sessionId),
        gt(staffGrants.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(staffGrants.grantedAt))
    .limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Acting as somebody else                                             */
/* ------------------------------------------------------------------ */

/**
 * Start one. The checks live in lib/auth/act-as.ts; this only writes.
 *
 * Deliberately separated: a function that both decides and writes is one that
 * a future caller can use to write without deciding. This one cannot be called
 * without having already answered the question, because it has no opinion at
 * all — which is also what makes the decision testable on its own.
 */
export async function createActAsGrant(input: {
  sessionId: string;
  actorUserId: string;
  targetUserId: string;
  reason: string;
  expiresAt: Date;
}) {
  const rows = await db.insert(actAsGrants).values(input).returning();
  return rows[0];
}

/**
 * The live grant on a session, if there is one.
 *
 * Live means both clocks agree: not given up, and not yet lapsed. This is the
 * single place that definition exists — `getSessionContext` reads it on every
 * request, so a grant that has run out stops working on the very next page,
 * without anything having to notice and clean up.
 *
 * Ordered newest first because renewal writes a NEW row rather than extending
 * the old one, so a session can legitimately hold more than one live grant for
 * the same person and the most recent is the one in force.
 */
export async function liveActAsGrantForSession(sessionId: string) {
  const rows = await db
    .select()
    .from(actAsGrants)
    .where(
      and(
        eq(actAsGrants.sessionId, sessionId),
        isNull(actAsGrants.endedAt),
        gt(actAsGrants.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(actAsGrants.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Give it up, now.
 *
 * `ended_at` is stamped rather than `expires_at` being pulled back, so the row
 * keeps saying what it was for AND when it really stopped. The row itself is
 * never deleted: the application role holds no DELETE on this table, so
 * erasing the record of an impersonation is a permission error rather than
 * anybody's decision.
 *
 * Every live grant on the session is ended, not merely the newest, because a
 * renewal leaves earlier rows live until their own hour runs out and one of
 * them would otherwise keep the access open.
 */
export async function endActAsGrantsForSession(sessionId: string): Promise<number> {
  const rows = await db
    .update(actAsGrants)
    .set({ endedAt: new Date() })
    .where(
      and(
        eq(actAsGrants.sessionId, sessionId),
        isNull(actAsGrants.endedAt),
        gt(actAsGrants.expiresAt, new Date()),
      ),
    )
    .returning({ id: actAsGrants.id });
  return rows.length;
}

/** What this session has done under this identity. The audit, read back. */
export async function actAsHistoryForActor(actorUserId: string, limit = 50) {
  return db
    .select({
      id: actAsGrants.id,
      targetUserId: actAsGrants.targetUserId,
      targetEmail: users.email,
      reason: actAsGrants.reason,
      startedAt: actAsGrants.startedAt,
      expiresAt: actAsGrants.expiresAt,
      endedAt: actAsGrants.endedAt,
      /**
       * Decided by the database's clock, in the same statement that reads the
       * row, rather than by comparing dates while the page renders. Two
       * reasons and both are real: a server component must be pure, and the
       * clock that governs the grant is Postgres's `now()` — the one
       * liveActAsGrantForSession() compares against — so asking anything else
       * would be a second opinion that can disagree with the one in force.
       */
      isLive: sql<boolean>`(${actAsGrants.endedAt} is null and ${actAsGrants.expiresAt} > now())`,
    })
    .from(actAsGrants)
    .innerJoin(users, eq(users.id, actAsGrants.targetUserId))
    .where(eq(actAsGrants.actorUserId, actorUserId))
    .orderBy(desc(actAsGrants.startedAt))
    .limit(limit);
}

/**
 * Who can be acted as, for the picker.
 *
 * Service accounts are left out: they cannot sign in at all, so there is no
 * "their side" to see, and one of them is the identity an API key writes as —
 * borrowing it would attribute human work to a machine. Deleted accounts are
 * left out for the obvious reason.
 *
 * This is a list of names and addresses and it is shown only to a staff
 * session, which already reaches every client's data.
 */
export async function listActAsCandidates() {
  return db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      isStaff: users.isStaff,
      /**
       * The outer column is written out in full rather than interpolated.
       *
       * Drizzle renders `${'${users.id}'}` inside a select-list expression as a bare
       * "id", and this subquery already has `memberships` and `organizations`
       * in scope — so Postgres rejects it as ambiguous at run time, not at
       * build time. Naming the table is the whole fix.
       */
      organizations: sql<string | null>`(
        select string_agg(o.name, ', ' order by o.name)
          from memberships m
          join organizations o on o.id = m.organization_id
         where m.user_id = "users"."id" and o.deleted_at is null
      )`,
    })
    .from(users)
    .where(and(isNull(users.deletedAt), eq(users.isService, false)))
    .orderBy(users.email);
}

/* ------------------------------------------------------------------ */
/* Domains and the cross-domain handoff                                */
/* ------------------------------------------------------------------ */

/**
 * The allowlist the handoff redeems against. A return destination is the id of
 * a row in this table — never a URL supplied by the caller — so there is no
 * address for an attacker's parser trick to exploit.
 */
export async function domainById(id: string) {
  const rows = await db
    .select()
    .from(organizationDomains)
    .where(eq(organizationDomains.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function domainByHostname(hostname: string) {
  const rows = await db
    .select({
      id: organizationDomains.id,
      hostname: organizationDomains.hostname,
      organizationId: organizationDomains.organizationId,
      organizationName: organizations.name,
      brandPrimaryHex: organizations.brandPrimaryHex,
      brandLogoUrl: organizations.brandLogoUrl,
    })
    .from(organizationDomains)
    .innerJoin(
      organizations,
      eq(organizations.id, organizationDomains.organizationId),
    )
    .where(eq(organizationDomains.hostname, hostname.toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

export async function mintTicket(input: {
  ticketHash: Buffer;
  userId: string;
  audienceHost: string;
  returnPath: string;
  sourceSessionId: string;
  expiresAt: Date;
}) {
  const rows = await db.insert(ssoTickets).values(input).returning();
  return rows[0];
}

/**
 * Redeem exactly once, atomically, and only by the host it was minted for.
 *
 * Every condition is in the UPDATE itself rather than being checked in a
 * preceding SELECT: two simultaneous attempts produce one winner and one
 * rejection, with no window in between. A ticket presented to the wrong host,
 * after its few seconds are up, or for a second time, returns nothing —
 * indistinguishable outcomes, so a failure reveals nothing about which
 * condition failed.
 */
export async function redeemTicket(
  ticketHash: Buffer,
  audienceHost: string,
): Promise<{ userId: string; returnPath: string; sourceSessionId: string } | null> {
  const rows = await db
    .update(ssoTickets)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(ssoTickets.ticketHash, ticketHash),
        eq(ssoTickets.audienceHost, audienceHost.toLowerCase()),
        isNull(ssoTickets.consumedAt),
        gt(ssoTickets.expiresAt, new Date()),
      ),
    )
    .returning({
      userId: ssoTickets.userId,
      returnPath: ssoTickets.returnPath,
      sourceSessionId: ssoTickets.sourceSessionId,
    });
  return rows[0] ?? null;
}

/**
 * Did the session that minted a ticket already clear its second factor?
 *
 * The handoff vouches for who someone is. It should vouch for HOW they proved
 * it too: the same person, in the same browser, satisfied the second factor at
 * the login host seconds ago, and asking for the same authenticator code again
 * on arrival is friction without a corresponding gain. This is the same thing
 * OpenID Connect carries as an `amr` claim — the issuer telling the relying
 * party which factors were actually used.
 *
 * Read from the source session rather than from anything in the request, so it
 * cannot be asserted by the caller.
 */
export async function sourceSessionClearedSecondFactor(
  sessionId: string,
): Promise<boolean> {
  const rows = await db
    .select({ secondFactorAt: sessions.secondFactorAt })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .limit(1);
  return rows[0]?.secondFactorAt !== null && rows[0]?.secondFactorAt !== undefined;
}

/** Sign-out kills tickets still in flight, not just established sessions. */
export async function consumeTicketsForSession(sessionId: string) {
  await db
    .update(ssoTickets)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(ssoTickets.sourceSessionId, sessionId),
        isNull(ssoTickets.consumedAt),
      ),
    );
}
