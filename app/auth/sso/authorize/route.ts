import { NextResponse, type NextRequest } from "next/server";
import { domainById, mintTicket } from "@/lib/db/identity";
import { getSessionContext } from "@/lib/auth/session";
import { secretToken } from "@/lib/ids";
import { SSO_TICKET_TTL_SECONDS } from "@/lib/auth/policy";
import { hashTicket, isPrimaryHost, originFor } from "@/lib/auth/sso";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Step 2, on the login host: mint a ticket for one named destination.
 *
 * The destination is an ID that indexes the table of registered client domains.
 * No URL is ever accepted, so there is no address for an attacker's parsing
 * trick to exploit — the two most recent real-world breaks of this exact
 * pattern were both open redirects, where the server's URL parser and the
 * browser's disagreed about a crafted string. A value that is not a known row
 * simply has no destination to redirect to.
 */
export async function GET(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();

  // Tickets are minted in exactly one place. A client domain cannot mint one.
  if (!isPrimaryHost(host)) {
    return new NextResponse("Sign-in happens on the login host only.", {
      status: 404,
    });
  }

  const site = request.nextUrl.searchParams.get("site") ?? "";
  const state = request.nextUrl.searchParams.get("state") ?? "";

  if (!UUID.test(site) || state.length < 16) {
    return new NextResponse("Bad handoff request.", { status: 400 });
  }

  const domain = await domainById(site);
  if (!domain) {
    return new NextResponse("Unknown destination.", { status: 400 });
  }

  // The `next` value below is a path on this host, which is why it is safe to
  // carry. Redirects are built from the Host header, not from request.url: in a
  // route handler request.url reports the address the server is bound to, so
  // using it here sends people to localhost instead of the login host.
  const resume = `/auth/sso/authorize?site=${encodeURIComponent(site)}&state=${encodeURIComponent(state)}`;

  const ctx = await getSessionContext();
  if (!ctx) {
    // Not signed in yet: sign in here, then resume exactly this handoff.
    return NextResponse.redirect(
      new URL(
        `/auth/login?next=${encodeURIComponent(resume)}`,
        originFor(host),
      ),
    );
  }

  // Staff who have passed the emailed code but not yet their authenticator
  // finish signing in HERE before being handed anywhere. Handing them over
  // half-done would move the second step onto the destination, and once the
  // portal has a host of its own that is every staff sign-in.
  if (ctx.needsSecondFactor) {
    return NextResponse.redirect(
      new URL(`/auth/2fa?next=${encodeURIComponent(resume)}`, originFor(host)),
    );
  }

  const token = secretToken(32);
  await mintTicket({
    ticketHash: hashTicket(token),
    // realUserId, not userId. While acting as somebody, userId is THEIR
    // account, and a ticket for it would become a full session as them on the
    // destination — one with no grant behind it, so no banner and no hour on
    // it. The act-as grant belongs to this session and does not travel.
    userId: ctx.realUserId,
    audienceHost: domain.hostname,
    returnPath: "/",
    // Tying the ticket to the session that minted it means signing out here
    // kills tickets that are still in flight, not just established sessions.
    sourceSessionId: ctx.sessionId,
    expiresAt: new Date(Date.now() + SSO_TICKET_TTL_SECONDS * 1000),
  });

  const callback = new URL(
    "/auth/sso/callback",
    originFor(domain.hostname),
  );
  callback.searchParams.set("ticket", token);
  callback.searchParams.set("state", state);

  const response = NextResponse.redirect(callback);
  // Nothing on this page should end up in a referrer header on the way out.
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
