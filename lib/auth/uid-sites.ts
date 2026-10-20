import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PORTAL_HOST, PRIMARY_HOST } from "./sso";

/**
 * UiD pages that sign in through this host.
 *
 * A UiD page (uid-rana.10xid.com, uid-bypaolo.10xid.com) is a small service of
 * its own, outside the portal, with no database. It signs people in the way a
 * client domain does: the browser comes here, and goes back with a short-lived,
 * single-use ticket bound to that one host (app/auth/uid/authorize). The UiD's
 * server then redeems the ticket here, server to server (app/api/uid/redeem),
 * proving which UiD it is with a secret only that service holds, and gets back
 * who signed in. It keeps its own session from then on, and asks every few
 * minutes whether the sign-in it came from is still live (app/api/uid/alive),
 * so signing out here ends it there too.
 *
 *   UID_SITES     host=address|address, comma-separated: each UiD, and the
 *                 portal accounts that may open it.
 *                 uid-rana.10xid.com=samay@tboxstudio.com|paolo@tboxstudio.com,
 *                 uid-bypaolo.10xid.com=paolo@tboxstudio.com
 *   UID_SITE_KEY  32+ random characters. Each UiD's secret is derived from it
 *                 and its host (uidSiteSecret), so one key here serves them
 *                 all and no UiD can act as another.
 *
 * Only hosts on a 10xid.com subdomain, other than this host and the portal's,
 * are taken. Without UID_SITE_KEY no UiD is.
 */

const ALLOWED_SUFFIX = ".10xid.com";
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const EMAIL = /^[^\s@|,=]+@[^\s@|,=]+\.[^\s@|,=]+$/;

export function parseUidSites(
  raw: string | undefined,
  loginHost = "",
  portalHost = "",
): Map<string, Set<string>> {
  const sites = new Map<string, Set<string>>();
  for (const entry of (raw ?? "").split(",")) {
    const at = entry.indexOf("=");
    if (at < 1) continue;
    const host = entry.slice(0, at).trim().toLowerCase();
    if (!HOST.test(host) || !host.endsWith(ALLOWED_SUFFIX)) continue;
    if (host === loginHost.toLowerCase() || host === portalHost.toLowerCase()) continue;
    const people = entry
      .slice(at + 1)
      .split("|")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => EMAIL.test(e));
    if (people.length) sites.set(host, new Set(people));
  }
  return sites;
}

/** The UiDs configured now, and who may open each. Read per call. */
export function uidSites(): Map<string, Set<string>> {
  return parseUidSites(process.env.UID_SITES, PRIMARY_HOST, PORTAL_HOST);
}

/** May this portal account's address open that UiD? */
export function mayOpenUid(host: string, email: string): boolean {
  return uidSites().get(host.toLowerCase())?.has(email.trim().toLowerCase()) ?? false;
}

/** The first of an account's addresses (lib/db/accounts: accountAddresses) that may open that UiD. */
export function uidAddress(host: string, emails: readonly string[]): string | null {
  return emails.find((e) => mayOpenUid(host, e)) ?? null;
}

/**
 * One UiD's secret: what its server sends to redeem a ticket or ask whether a
 * sign-in is still live. Null when there is no usable key, which switches
 * every UiD off.
 */
export function uidSiteSecret(host: string, key = process.env.UID_SITE_KEY): string | null {
  if (!key || key.length < 32) return null;
  return createHmac("sha256", key).update(`uid-site:${host.toLowerCase()}`).digest("base64url");
}

/** Is this request from that UiD's own server? `Authorization: Bearer <its secret>`. */
export function isUidSiteCaller(host: string, authorization: string | null): boolean {
  if (!uidSites().has(host.toLowerCase())) return false;
  const secret = uidSiteSecret(host);
  const given = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? "";
  if (!secret || !given) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
