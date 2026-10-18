import { NextResponse, type NextRequest } from "next/server";
import { mintTicket } from "@/lib/db/identity";
import { userByAuthUserId } from "@/lib/db/accounts";
import { getLoginSession } from "@/lib/auth/login";
import { secretToken } from "@/lib/ids";
import { SSO_TICKET_TTL_SECONDS } from "@/lib/auth/policy";
import { hashTicket, isPrimaryHost, originFor } from "@/lib/auth/sso";
import { mayOpenUid, uidSiteSecret, uidSites } from "@/lib/auth/uid-sites";

/**
 * A UiD page's sign-in, on the login host: mint a ticket for that UiD
 * (lib/auth/uid-sites). The same three conditions as the portal's handoff
 * (app/auth/sso/authorize) — a sign-in session here, past the authenticator,
 * bound to a portal account — and a fourth: UID_SITES lets that account open
 * that UiD. The UiD is named by its host, which must be one UID_SITES lists;
 * nothing else is accepted, so there is no address to smuggle in.
 */
export async function GET(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  if (!isPrimaryHost(host)) {
    return new NextResponse("Sign-in happens on the login host only.", { status: 404 });
  }

  const uid = (request.nextUrl.searchParams.get("host") ?? "").toLowerCase();
  const state = request.nextUrl.searchParams.get("state") ?? "";
  if (!uidSites().has(uid) || !uidSiteSecret(uid) || state.length < 16 || state.length > 256) {
    return new NextResponse("Unknown UiD.", { status: 400 });
  }

  const resume = `/auth/uid/authorize?host=${encodeURIComponent(uid)}&state=${encodeURIComponent(state)}`;
  const here = (path: string) =>
    NextResponse.redirect(new URL(`${path}?next=${encodeURIComponent(resume)}`, originFor(host)));

  const session = await getLoginSession();
  if (!session) return here("/auth/sign-in");
  if (!session.mfaVerifiedAt) return here("/auth/mfa");

  const account = await userByAuthUserId(session.user.id);
  if (!account) return here("/auth/access");
  if (!mayOpenUid(uid, account.email)) {
    // Never a dead end: a page that offers "Sign out and switch account" and
    // brings the person back here once they are signed in as the right address.
    const denied = here("/auth/uid/denied");
    denied.headers.set("Cache-Control", "no-store");
    return denied;
  }

  const token = secretToken(32);
  await mintTicket({
    ticketHash: hashTicket(token),
    userId: account.id,
    audienceHost: uid,
    returnPath: "/",
    sourceAuthSessionId: session.sessionId,
    expiresAt: new Date(Date.now() + SSO_TICKET_TTL_SECONDS * 1000),
  });

  const callback = new URL("/auth/callback", `https://${uid}`);
  callback.searchParams.set("ticket", token);
  callback.searchParams.set("state", state);

  const response = NextResponse.redirect(callback);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  return response;
}
