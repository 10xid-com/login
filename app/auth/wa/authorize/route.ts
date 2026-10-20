import { NextRequest, NextResponse } from "next/server";
import { getLoginSession } from "@/lib/auth/login";
import { userByAuthUserId } from "@/lib/db/accounts";
import { mintTicket } from "@/lib/db/identity";
import { hashTicket, isPrimaryHost, originFor } from "@/lib/auth/sso";
import { makeOpaqueCode, validateWaAuthorization, WA_CALLBACK, WA_AUDIENCE, WA_CODE_LIFETIME_MS } from "@/lib/auth/wa-external";

export async function GET(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  if (!isPrimaryHost(host)) return new NextResponse("Not found", { status: 404 });
  const clientId = request.nextUrl.searchParams.get("client_id") ?? "";
  const redirectUri = request.nextUrl.searchParams.get("redirect_uri") ?? "";
  const state = request.nextUrl.searchParams.get("state") ?? "";
  if (!validateWaAuthorization({clientId, redirectUri, state}, process.env.WA_EXTERNAL_CLIENT_ID ?? "")) {
    return new NextResponse("Invalid authorization request", { status: 400 });
  }
  if (!process.env.WA_EXTERNAL_CLIENT_SECRET) return new NextResponse("Unavailable", { status: 503 });
  const resume = "/auth/wa/authorize?" + new URLSearchParams({client_id: clientId, redirect_uri: redirectUri, state});
  const sendTo = (path: string) => NextResponse.redirect(new URL(path + "?next=" + encodeURIComponent(resume), originFor(host)));
  const session = await getLoginSession();
  if (!session) return sendTo("/auth/sign-in");
  if (!session.mfaVerifiedAt) return sendTo("/auth/mfa");
  // Linking accounts is sensitive: require a recent authenticator check.
  if (Date.now() - session.mfaVerifiedAt.getTime() > 5 * 60 * 1000) {
    return sendTo("/auth/mfa/again");
  }
  const account = await userByAuthUserId(session.user.id);
  if (!account) return sendTo("/auth/access");
  const code = makeOpaqueCode();
  await mintTicket({
    ticketHash: hashTicket(code), userId: account.id,
    audienceHost: WA_AUDIENCE, returnPath: "/",
    sourceAuthSessionId: session.sessionId,
    expiresAt: new Date(Date.now() + WA_CODE_LIFETIME_MS),
  });
  const callback = new URL(WA_CALLBACK);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", state);
  const response = NextResponse.redirect(callback);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
