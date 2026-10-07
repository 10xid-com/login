import { NextResponse, type NextRequest } from "next/server";
import { domainById, mintTicket } from "@/lib/db/identity";
import { userByAuthUserId } from "@/lib/db/accounts";
import { getLoginSession } from "@/lib/auth/login";
import { secretToken } from "@/lib/ids";
import { SSO_TICKET_TTL_SECONDS } from "@/lib/auth/policy";
import { PORTAL_HOST, hashTicket, isPrimaryHost, originFor } from "@/lib/auth/sso";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Step 2, on the login host: mint a ticket for one named destination.
 *
 * The destination is an ID that indexes the table of registered client domains.
 * No URL is ever accepted, so there is no address for an attacker's parsing
 * trick to exploit. With PORTAL_HOST set, that is also the only host a ticket
 * is minted for, whatever else the table holds.
 *
 * A ticket is minted only when all three hold, checked here on every handoff:
 *   1. a sign-in session on this host (Better Auth; host-only cookie),
 *   2. that has passed the authenticator — after ANY way of signing in,
 *   3. whose identity is bound to a portal account (an accepted invitation or
 *      an operator's confirmation; a matching address alone is not enough).
 * The ticket names the sign-in session it came from, so the portal session it
 * becomes ends when that one does: signing out here, expiry, or inactivity.
 */
export async function GET(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();

  // Tickets are minted in exactly one place. A client domain cannot mint one.
  if (!isPrimaryHost(host)) {
    return new NextResponse("Sign-in happens on the login host only.", { status: 404 });
  }

  const site = request.nextUrl.searchParams.get("site") ?? "";
  const state = request.nextUrl.searchParams.get("state") ?? "";
  if (!UUID.test(site) || state.length < 16 || state.length > 256) {
    return new NextResponse("Bad handoff request.", { status: 400 });
  }

  const domain = await domainById(site);
  if (!domain || (PORTAL_HOST && domain.hostname.toLowerCase() !== PORTAL_HOST)) {
    return new NextResponse("Unknown destination.", { status: 400 });
  }

  // Redirects are built from the Host header, not from request.url: in a route
  // handler request.url reports the address the server is bound to.
  const resume = `/auth/sso/authorize?site=${encodeURIComponent(site)}&state=${encodeURIComponent(state)}`;
  const here = (path: string) =>
    NextResponse.redirect(new URL(`${path}?next=${encodeURIComponent(resume)}`, originFor(host)));

  const session = await getLoginSession();
  if (!session) return here("/auth/sign-in");
  if (!session.mfaVerifiedAt) return here("/auth/mfa");

  const account = await userByAuthUserId(session.user.id);
  if (!account) return here("/auth/access");

  const token = secretToken(32);
  await mintTicket({
    ticketHash: hashTicket(token),
    userId: account.id,
    audienceHost: domain.hostname,
    returnPath: "/",
    sourceAuthSessionId: session.sessionId,
    expiresAt: new Date(Date.now() + SSO_TICKET_TTL_SECONDS * 1000),
  });

  const callback = new URL("/auth/sso/callback", originFor(domain.hostname));
  callback.searchParams.set("ticket", token);
  callback.searchParams.set("state", state);

  const response = NextResponse.redirect(callback);
  // Nothing on this page should end up in a referrer header on the way out.
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  return response;
}
