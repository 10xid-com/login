import "server-only";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { authDb } from "@/lib/db/auth-connection";
import { authSessions, authTwoFactors, authUsers } from "@/lib/db/schema";
import { revokePortalSessionsForUser, userByAuthUserId, normalizeEmail } from "@/lib/db/accounts";
import { getLoginSession, type LoginIdentity } from "./login";

/**
 * THE OPERATOR SCREEN'S RULES (/auth/operator).
 *
 * An operator is a person whose bound portal account's address is listed in
 * OPERATOR_EMAILS on the login service — a deliberate list, changed only by
 * whoever can change the service's variables, and empty (nobody) by default.
 * Being an operator also needs a sign-in that has passed the authenticator,
 * and every action needs it again within the last five minutes (a code typed
 * with the action), so an unattended browser is not an operator console.
 *
 * What an operator does goes through the database's operator_* functions
 * (0023), callable only by this service's sign-in role, plus the sign-in
 * tables this service already owns. Every action is logged with who did it.
 */

export const OPERATOR_FRESH_SECONDS = 5 * 60;

export function operatorEmails(): Set<string> {
  return new Set(
    (process.env.OPERATOR_EMAILS ?? "")
      .split(",")
      .map((e) => normalizeEmail(e))
      .filter((e) => e.includes("@")),
  );
}

export type Operator = {
  session: LoginIdentity;
  accountId: string;
  email: string;
  name: string;
};

/** The operator making this request, or null for anybody else. */
export async function getOperator(): Promise<Operator | null> {
  const session = await getLoginSession();
  if (!session?.mfaVerifiedAt) return null;
  const account = await userByAuthUserId(session.user.id);
  if (!account) return null;
  const email = normalizeEmail(account.email);
  if (!operatorEmails().has(email)) return null;
  return { session, accountId: account.id, email, name: account.fullName || email };
}

export function isFresh(op: Operator, now = Date.now()): boolean {
  return now - op.session.mfaVerifiedAt!.getTime() < OPERATOR_FRESH_SECONDS * 1000;
}

export function logOperator(op: Operator, action: string, target: string, outcome: string) {
  console.info(`[operator] ${op.email} ${action} ${target} → ${outcome}`);
}

/* ------------------------------------------------------------------ */

export type OpenBinding = {
  id: string;
  email: string;
  auth_user_id: string;
  requested_at: Date;
  account_email: string;
  full_name: string | null;
  businesses: string;
};

export async function openBindings(): Promise<OpenBinding[]> {
  const r = await authDb().execute<OpenBinding>(sql`select * from operator_open_bindings()`);
  return r.rows;
}

export async function decideBinding(requestId: string, confirm: boolean, decidedBy: string): Promise<string> {
  const r = await authDb().execute<{ outcome: string }>(
    sql`select operator_decide_binding(${requestId}::uuid, ${confirm}, ${decidedBy}) as outcome`,
  );
  return r.rows[0]?.outcome ?? "failed";
}

export async function clientBusinesses(): Promise<{ id: string; name: string }[]> {
  const r = await authDb().execute<{ id: string; name: string }>(sql`select * from operator_client_businesses()`);
  return r.rows;
}

export const INVITE_ROLES = ["owner", "manager", "editor", "publisher", "asset_manager", "viewer"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export async function invite(email: string, businessId: string, role: InviteRole, invitedBy: string): Promise<Date> {
  const r = await authDb().execute<{ expires: Date | string }>(
    sql`select operator_invite(${email}, ${businessId}::uuid, ${role}::membership_role, ${invitedBy}::uuid) as expires`,
  );
  return new Date(r.rows[0]!.expires);
}

/**
 * End every sign-in of the identity holding this address, and every portal
 * session of the account it is bound to. With `resetAuthenticator`, also
 * remove its authenticator and recovery codes: the next sign-in (by emailed
 * code) sets up a new one.
 */
export async function endAccess(
  emailRaw: string,
  opts: { resetAuthenticator: boolean },
): Promise<"done" | "no_identity"> {
  const email = normalizeEmail(emailRaw);
  const [identity] = await authDb().select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email)).limit(1);
  if (!identity) return "no_identity";
  await authDb().transaction(async (tx) => {
    if (opts.resetAuthenticator) {
      await tx.delete(authTwoFactors).where(eq(authTwoFactors.userId, identity.id));
    }
    await tx.delete(authSessions).where(and(eq(authSessions.userId, identity.id)));
  });
  const account = await userByAuthUserId(identity.id);
  if (account) await revokePortalSessionsForUser(account.id);
  return "done";
}
