import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Cross-domain sign-in: shared pieces.
 *
 * A browser will not let a cookie cross from one registrable domain to another,
 * and every workaround is closed — third-party cookies are gone in Safari,
 * partitioned in Firefox, partitioned cookies cannot be shared across sites by
 * design, and the one browser feature that granted this automatically was
 * removed from Chrome in September 2026.
 *
 * What remains is a top-level redirect, which is what this implements. It is
 * the OAuth authorization-code exchange: the login host mints a short-lived,
 * single-use ticket bound to one destination, the browser carries it there, and
 * that destination redeems it server-side for its OWN first-party cookie.
 */

export const PRIMARY_HOST = (process.env.PRIMARY_HOST ?? "").toLowerCase();

const SECURE = process.env.SESSION_COOKIE_SECURE !== "false";

/** The state cookie only has to survive one redirect. */
export const SSO_STATE_COOKIE = SECURE
  ? "__Host-portal_sso_state"
  : "portal_sso_state";

export const SSO_STATE_TTL_SECONDS = 120;

export function isPrimaryHost(host: string): boolean {
  return host.toLowerCase() === PRIMARY_HOST;
}

export function originFor(host: string): string {
  return `${SECURE ? "https" : "http"}://${host}`;
}

/**
 * Where the portal pages live, if not on the login host (see proxy.ts).
 */
export const PORTAL_HOST = (process.env.PORTAL_HOST ?? "").toLowerCase();

/**
 * The sign-in form, as a full address on the login host.
 *
 * Server code sends people here rather than to a bare "/auth/sign-in" because a
 * server action's redirect to a path is rendered within the same request, on
 * the host the action ran on, without passing through proxy.ts. From the portal
 * that would draw a sign-in form on a host that must not have one. A full
 * address is a real navigation, so it lands on the login host.
 */
export function signInUrl(): string {
  return PRIMARY_HOST ? `${originFor(PRIMARY_HOST)}/auth/sign-in` : "/auth/sign-in";
}

/**
 * Where a "where were you going" path leads once sign-in is done.
 *
 * With the portal on its own host, a portal path is a page there, so it is
 * given by full address for the same reason as signInUrl(). A path under /auth/
 * is the sign-in plumbing — resuming a handoff, say — and stays on this host.
 * The input is expected to have been through safePath() already.
 */
export function afterSignIn(path: string): string {
  if (!PORTAL_HOST || PORTAL_HOST === PRIMARY_HOST) return path;
  if (path.startsWith("/auth/")) return path;
  return `${originFor(PORTAL_HOST)}${path}`;
}

export function hashTicket(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Where to land after the handoff.
 *
 * This is read from the initiating site's OWN cookie and never from the URL
 * coming back, so the destination is never influenced by anything that made the
 * round trip. Even so it is re-validated here: a value that is not plainly a
 * local path is discarded. `//evil.test` is the case a naive "starts with a
 * slash" check waves straight through, and it is a fully qualified URL to a
 * browser.
 */
export function safePath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) return "/";
  if (!input.startsWith("/")) return "/";
  if (input.startsWith("//")) return "/";
  if (input.includes("\\")) return "/";
  if (/[\p{Cc}]/u.test(input)) return "/";
  return input;
}

export type SsoState = { state: string; path: string };

export function encodeState(value: SsoState): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeState(raw: string | undefined): SsoState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed?.state !== "string") return null;
    return { state: parsed.state, path: safePath(parsed.path) };
  } catch {
    return null;
  }
}

/**
 * Compare the state the browser brought back with the one this site issued.
 *
 * This is what stops login CSRF: without it, someone could hand a victim's
 * browser a ticket for the ATTACKER'S account and silently sign them into it,
 * so that everything the victim then did happened inside the attacker's
 * company. The comparison is constant time for the same reason every other
 * secret comparison here is.
 */
export function statesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
