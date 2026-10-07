import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import {
  redeemTicket,
  sourceSessionClearedSecondFactor,
} from "@/lib/db/identity";
import { startSession, writeSessionCookie } from "@/lib/auth/session";
import { SESSION_POLICY } from "@/lib/auth/policy";
import {
  SSO_STATE_COOKIE,
  decodeState,
  hashTicket,
  isPrimaryHost,
  originFor,
  statesMatch,
} from "@/lib/auth/sso";

/**
 * Step 3, on the client domain: redeem the ticket for a first-party session.
 *
 * Two independent checks have to pass, and they guard different things:
 *
 *   the state cookie   proves this browser started the flow. Without it,
 *                      someone could hand a victim a ticket for their own
 *                      account and silently sign the victim into it.
 *   the ticket         proves the login host vouched for this person, for
 *                      THIS host, within the last few seconds, once.
 *
 * The redemption is a single atomic update. Two simultaneous attempts produce
 * exactly one winner; there is no window between checking and spending.
 */
export async function GET(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();

  if (isPrimaryHost(host)) {
    return new NextResponse("Not a handoff destination.", { status: 404 });
  }

  const jar = await cookies();
  const expected = decodeState(jar.get(SSO_STATE_COOKIE)?.value);
  const returned = request.nextUrl.searchParams.get("state") ?? "";
  const ticket = request.nextUrl.searchParams.get("ticket") ?? "";

  // Built from the Host header throughout: in a route handler request.url
  // reports the address the server is bound to, not the domain the person is
  // actually on, which would land them on localhost.
  const self = originFor(host);
  const fail = () => NextResponse.redirect(new URL("/auth/sso/failed", self));

  if (!expected || !ticket || !statesMatch(expected.state, returned)) {
    return fail();
  }

  // Bound to this host: a ticket minted for another client domain is worthless
  // here, so a leaked ticket cannot be spent anywhere but its destination.
  const redeemed = await redeemTicket(hashTicket(ticket), host);
  if (!redeemed) return fail();

  // Carry across how they proved who they are, not just that they did. The
  // login host checked the second factor moments ago, in this same browser;
  // asking for the same authenticator code again on arrival is friction with
  // nothing bought by it.
  const clearedSecondFactor = await sourceSessionClearedSecondFactor(
    redeemed.sourceSessionId,
  );

  const { token, role } = await startSession({
    userId: redeemed.userId,
    host,
    secondFactorPassed: clearedSecondFactor,
    sourceSessionId: redeemed.sourceSessionId,
  });

  await writeSessionCookie(
    token,
    new Date(Date.now() + SESSION_POLICY[role].absoluteSeconds * 1000),
  );

  jar.set(SSO_STATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SESSION_COOKIE_SECURE !== "false",
    path: "/",
    maxAge: 0,
  });

  // 303 so the spent ticket leaves the address bar immediately rather than
  // sitting in history and being re-sent on a refresh.
  const response = NextResponse.redirect(new URL(expected.path, self), 303);
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
