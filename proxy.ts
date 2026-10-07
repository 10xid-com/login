import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy — renamed from Middleware in Next.js 16, same job.
 *
 * This does a few cheap things, all of them routing:
 *
 *   - a request arriving at a client domain with no session cookie at all is
 *     sent into the cross-domain handoff instead of rendering a signed-out page;
 *   - the sign-in screens are only ever shown on the login host;
 *   - when PORTAL_HOST is set, the login host keeps /auth/* and nothing else,
 *     and every portal page is sent to PORTAL_HOST.
 *
 * It deliberately does not validate the session. Next's own guidance is that
 * this layer is for optimistic checks and must not be a session-management or
 * authorisation solution — it runs before routes, without the database, and a
 * check here would be a check in the wrong place. Real enforcement happens in
 * the data access layer, with Postgres enforcing the same rule underneath, so a
 * forged or stale cookie gets past this and then gets nothing.
 *
 * In other words: this is a convenience that saves a redirect, not a gate.
 */

const SESSION_COOKIES = [
  "__Host-portal_session",
  "portal_session",
  // Better Auth's, on the login host (lib/auth/auth.ts: cookiePrefix "10xid").
  "__Secure-10xid.session_token",
  "10xid.session_token",
];

/**
 * The screens where somebody proves who they are. Sign-in happens on the login
 * host and nowhere else; another host showing its own form would be a second
 * place to authenticate. A visit to one elsewhere — signing out of the portal
 * lands on /auth/login, for instance — is sent to the login host's copy.
 *
 * The second-factor and recovery-code screens are not in this list: they act on
 * the session of the host they are on, so they have to stay where they are.
 */
const SIGN_IN_PAGES = new Set([
  "/auth/login",
  "/auth/signup",
  "/auth/verify",
  "/auth/sign-in",
  "/auth/sign-in/code",
  "/auth/sign-up",
  "/auth/verify-email",
  "/auth/forgot-password",
  "/auth/reset-password",
]);

/** The same rule as originFor() in lib/auth/sso, which is server-only. */
function originFor(host: string): string {
  const secure = process.env.SESSION_COOKIE_SECURE !== "false";
  return `${secure ? "https" : "http"}://${host}`;
}

export function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const primary = (process.env.PRIMARY_HOST ?? "").toLowerCase();
  const portal = (process.env.PORTAL_HOST ?? "").toLowerCase();
  const { pathname, search } = request.nextUrl;
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));

  // Never interfere with the machine endpoints. They carry an API key rather
  // than a cookie, and redirecting one would answer a POST with a 307 to an
  // HTML page — which a caller reads as "it worked, sort of", and which is a
  // far more confusing failure than a plain 401. They answer on every host.
  if (pathname.startsWith("/api/")) return NextResponse.next();

  // The platform's healthcheck: answered on every host, never redirected.
  if (pathname === "/healthz") return NextResponse.next();

  if (primary && host !== primary && SIGN_IN_PAGES.has(pathname)) {
    return NextResponse.redirect(
      new URL(`${pathname}${search}`, originFor(primary)),
    );
  }

  // Otherwise never interfere with the sign-in plumbing itself — doing so is
  // how you build a redirect loop that only shows up on the one domain you did
  // not test.
  if (pathname.startsWith("/auth/")) return NextResponse.next();

  // The login host, once the portal has a host of its own. A person with no
  // session here is about to be asked to sign in either way, so they are asked
  // now, and sent on afterwards: `next` is a path, and the login host forwards
  // that path to the portal on the way back out. With a session, the portal
  // host takes it from here, by the ordinary handoff.
  if (primary && portal && portal !== primary && host === primary) {
    if (!hasSession) {
      const login = request.nextUrl.clone();
      login.pathname = "/auth/sign-in";
      login.search = "";
      login.searchParams.set("next", `${pathname}${search}`);
      return NextResponse.redirect(login);
    }
    return NextResponse.redirect(
      new URL(`${pathname}${search}`, originFor(portal)),
    );
  }

  // A cookie being PRESENT is all that is checked. Whether it is valid is the
  // application's business, not this layer's.
  if (hasSession) return NextResponse.next();

  // On the login host, an unauthenticated visit is an ordinary sign-in.
  if (!primary || host === primary) return NextResponse.next();

  // On a client domain, it is the first step of the handoff.
  const start = request.nextUrl.clone();
  start.pathname = "/auth/sso/start";
  start.search = "";
  start.searchParams.set("path", `${pathname}${search}`);
  return NextResponse.redirect(start);
}

export const config = {
  matcher: [
    // Everything except Next's own assets and static files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
