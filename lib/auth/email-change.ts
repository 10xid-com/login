import "server-only";
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { authDb } from "@/lib/db/auth-connection";
import { authVerifications } from "@/lib/db/schema";
import { normalizeEmail } from "@/lib/db/accounts";
import { sendAddressChanged, sendAuthCode } from "./mailer";

/**
 * A person moves their account to a new address, from the account page.
 *
 * Two steps, both by somebody signed in past the authenticator:
 *   1. ask: a six-digit code goes to the NEW address. It is sent whether or
 *      not the address is free, so the answer never says which addresses
 *      already have an account.
 *   2. confirm: the code, typed back on the account page, proves the mailbox;
 *      only then does the database move the account and its sign-in
 *      (account_change_email, 0050). The old address gets a notice.
 *
 * One outstanding request per sign-in identity, ten minutes, five tries. The
 * code is kept only as a hash, in auth_verifications under its own prefix.
 */

export const EMAIL_CHANGE_MINUTES = 10;
const MAX_TRIES = 5;

const identifier = (authUserId: string) => `email-change:${authUserId}`;
const digest = (authUserId: string, code: string) =>
  createHash("sha256").update(`${authUserId}:${code}`).digest("hex");

type Pending = { email: string; hash: string; tries: number };

export async function requestEmailChange(authUserId: string, newEmailRaw: string): Promise<void> {
  const email = normalizeEmail(newEmailRaw);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const value: Pending = { email, hash: digest(authUserId, code), tries: 0 };
  await authDb().transaction(async (tx) => {
    await tx.delete(authVerifications).where(eq(authVerifications.identifier, identifier(authUserId)));
    await tx.insert(authVerifications).values({
      id: randomUUID(),
      identifier: identifier(authUserId),
      value: JSON.stringify(value),
      expiresAt: new Date(Date.now() + EMAIL_CHANGE_MINUTES * 60 * 1000),
    });
  });
  await sendAuthCode({ to: email, code, purpose: "email-change", expiresInMinutes: EMAIL_CHANGE_MINUTES });
}

/** The address a code is waiting for, if any. */
export async function pendingEmailChange(authUserId: string): Promise<string | null> {
  const row = await live(authUserId);
  return row ? row.pending.email : null;
}

export async function cancelEmailChange(authUserId: string): Promise<void> {
  await authDb().delete(authVerifications).where(eq(authVerifications.identifier, identifier(authUserId)));
}

export type EmailChangeOutcome = "changed" | "code" | "expired" | "taken" | "unchanged" | "no_account" | "invalid";

export async function confirmEmailChange(
  authUserId: string,
  oldEmail: string,
  code: string,
): Promise<{ outcome: EmailChangeOutcome; email?: string }> {
  const row = await live(authUserId);
  if (!row) return { outcome: "expired" };
  const { id, pending } = row;

  const given = Buffer.from(digest(authUserId, code), "hex");
  const wanted = Buffer.from(pending.hash, "hex");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    const tries = pending.tries + 1;
    if (tries >= MAX_TRIES) {
      await authDb().delete(authVerifications).where(eq(authVerifications.id, id));
      return { outcome: "expired" };
    }
    await authDb()
      .update(authVerifications)
      .set({ value: JSON.stringify({ ...pending, tries }), updatedAt: new Date() })
      .where(eq(authVerifications.id, id));
    return { outcome: "code" };
  }

  await authDb().delete(authVerifications).where(eq(authVerifications.id, id));
  const r = await authDb().execute<{ outcome: EmailChangeOutcome }>(
    sql`select account_change_email(${authUserId}, ${pending.email}) as outcome`,
  );
  const outcome = r.rows[0]?.outcome ?? "invalid";
  if (outcome === "changed") {
    void sendAddressChanged({ to: oldEmail, newEmail: pending.email }).catch((error: unknown) =>
      console.error("[email-change] notice not sent:", error instanceof Error ? error.message : "unknown"),
    );
  }
  return { outcome, email: pending.email };
}

async function live(authUserId: string): Promise<{ id: string; pending: Pending } | null> {
  const [row] = await authDb()
    .select({ id: authVerifications.id, value: authVerifications.value })
    .from(authVerifications)
    .where(and(eq(authVerifications.identifier, identifier(authUserId)), gt(authVerifications.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;
  try {
    return { id: row.id, pending: JSON.parse(row.value) as Pending };
  } catch {
    return null;
  }
}
