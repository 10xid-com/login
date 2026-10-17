import "server-only";

/**
 * A person's own UiD: where signing in ends for them instead of the portal.
 *
 * Some people work from a UiD page of their own (uid-bypaolo.10xid.com,
 * uid-rana.10xid.com) rather than the portal. UID_HOMES on the login service
 * lists them, one `address=https://…` pair per person, comma-separated:
 *
 *   UID_HOMES=paolo@10xid.com=https://uid-bypaolo.10xid.com/v3/,rana@example.com=https://uid-rana.10xid.com/
 *
 * The address is the portal account's (users.email), so an identity only
 * reaches its UiD once it is bound to that account and past the authenticator
 * (see uidHomeForSession in lib/auth/login). Anybody not listed goes to the
 * portal as before.
 *
 * Only https addresses on a 10xid.com subdomain other than the login host are
 * taken, so a mistyped or hostile value can never turn sign-in into a redirect
 * to somewhere else, or back into itself. A pair that does not pass is
 * dropped, and that person simply goes to the portal.
 *
 * This is a redirect, not a sign-in: a UiD page does not redeem the
 * cross-domain handoff, and keeps its own passcode for anything it changes.
 */

const ALLOWED_SUFFIX = ".10xid.com";

export function parseUidHomes(raw: string | undefined, loginHost = ""): Map<string, string> {
  const homes = new Map<string, string>();
  for (const pair of (raw ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at < 1) continue;
    const email = pair.slice(0, at).trim().toLowerCase();
    const url = uidUrl(pair.slice(at + 1).trim(), loginHost.toLowerCase());
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && url) homes.set(email, url);
  }
  return homes;
}

function uidUrl(value: string, loginHost: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!host.endsWith(ALLOWED_SUFFIX) || host === loginHost) return null;
  return url.toString();
}

/** The UiD for a portal account's address, if it has one. Read per call, never cached. */
export function uidHomeFor(email: string): string | null {
  const homes = parseUidHomes(process.env.UID_HOMES, process.env.PRIMARY_HOST);
  return homes.get(email.trim().toLowerCase()) ?? null;
}
