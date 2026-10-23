import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { authDb } from "@/lib/db/auth-connection";
import { authAccounts, authUsers } from "@/lib/db/schema";
import { accountAddresses, normalizeEmail, userByAuthUserId } from "@/lib/db/accounts";
import { uidAddress } from "./uid-sites";

/**
 * A 10XiD password, checked for another site's own sign-in form.
 *
 * Branding Centres and Wrap Authority keep their own sign-in pages. When
 * somebody types their 10XiD address and password there, that site's server
 * posts them here (app/api/uid/password), proving which site it is with the
 * same per-site secret a UiD uses (lib/auth/uid-sites), and gets back whether
 * they are right. It then signs the person into its own account for that
 * address. The password is never stored there.
 *
 * Deliberately, this is the one way in that does NOT ask for the
 * authenticator: the point is that one password opens every listed site. What
 * bounds it instead: only the addresses UID_SITES lists for that site, only a
 * live portal account, and a limit on wrong guesses per address.
 *
 * The answer carries a stamp the site keeps with its session and sends back
 * to /api/uid/alive every few minutes. A stamp stops being good when the
 * password changes, the account goes, or UID_SITES stops listing the address,
 * so any of those signs the person out of that site too.
 */

let dummyHash: Promise<string> | null = null;

/** Checked when there is no password to check, so a wrong address takes as long as a wrong password. */
function noAccountHash(): Promise<string> {
  dummyHash ??= hashPassword("no account has this password, it only takes the time one would");
  return dummyHash;
}

async function identityByEmail(email: string) {
  const [row] = await authDb()
    .select({ id: authUsers.id, name: authUsers.name, hash: authAccounts.password })
    .from(authUsers)
    .innerJoin(authAccounts, and(eq(authAccounts.userId, authUsers.id), eq(authAccounts.providerId, "credential")))
    .where(eq(authUsers.email, email))
    .limit(1);
  return row?.hash ? { id: row.id, name: row.name, hash: row.hash } : null;
}

async function passwordHashFor(authUserId: string): Promise<string | null> {
  const [row] = await authDb()
    .select({ hash: authAccounts.password })
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, authUserId), eq(authAccounts.providerId, "credential")))
    .limit(1);
  return row?.hash ?? null;
}

function mac(host: string, authUserId: string, hash: string, key: string): string {
  return createHmac("sha256", key).update(`site-password:${host}:${authUserId}:${hash}`).digest("base64url");
}

/** The stamp for this sign-in: who, bound to this site and to the password as it is now. */
export function sitePasswordStamp(host: string, authUserId: string, hash: string, key = process.env.UID_SITE_KEY): string | null {
  if (!key || key.length < 32) return null;
  return `${authUserId}.${mac(host.toLowerCase(), authUserId, hash, key)}`;
}

function stampMatches(stamp: string, host: string, authUserId: string, hash: string): boolean {
  const expected = sitePasswordStamp(host, authUserId, hash);
  if (!expected) return false;
  const a = Buffer.from(stamp, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Is this the 10XiD password for an account that site may sign in? The
 * address UID_SITES lists for it (which may be a spare of the one typed),
 * its name, and the stamp; or null, whichever check failed.
 */
export async function checkSitePassword(
  host: string,
  emailRaw: string,
  password: string,
): Promise<{ email: string; name: string; stamp: string } | null> {
  const identity = await identityByEmail(normalizeEmail(emailRaw));
  const ok = await verifyPassword({ hash: identity?.hash ?? (await noAccountHash()), password });
  if (!identity || !ok) return null;

  const account = await userByAuthUserId(identity.id);
  const address = account ? uidAddress(host, await accountAddresses(account.id)) : null;
  const stamp = sitePasswordStamp(host, identity.id, identity.hash);
  if (!account || !address || !stamp) return null;
  return { email: address, name: account.fullName || identity.name || "", stamp };
}

/** Is a sign-in made with checkSitePassword still good? */
export async function sitePasswordLive(host: string, emailRaw: string, stamp: string): Promise<boolean> {
  const authUserId = stamp.split(".")[0] ?? "";
  if (!authUserId || stamp.length > 256) return false;
  const hash = await passwordHashFor(authUserId);
  if (!hash || !stampMatches(stamp, host.toLowerCase(), authUserId, hash)) return false;
  const account = await userByAuthUserId(authUserId);
  const address = account ? uidAddress(host, await accountAddresses(account.id)) : null;
  return address === normalizeEmail(emailRaw);
}
