import { NextRequest, NextResponse } from "next/server";
import { getLoginSession } from "@/lib/auth/login";
import { userByAuthUserId } from "@/lib/db/accounts";
import { mintTicket } from "@/lib/db/identity";
import { hashTicket } from "@/lib/auth/sso";
import { getAuth } from "@/lib/auth/auth";
import { headers } from "next/headers";
import { allow } from "@/lib/auth/throttle";
import { makeOpaqueCode, validateWaAuthorization, waClient, WA_CODE_LIFETIME_MS } from "@/lib/auth/wa-external";
import { seal, open, freshMfa } from "@/lib/wrapauthority/protocol";
export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
function failure(status: number) { return new NextResponse("Linking failed. Restart from Wrap Authority.", { status, headers: noStore }); }
export async function GET(request: NextRequest) {
  const config = waClient(), secret = process.env.WA_EXTERNAL_CLIENT_SECRET;
  if (!config || !secret || secret.length < 32) return failure(503);
  if (request.headers.get("host")?.toLowerCase() !== new URL(config.loginOrigin).host) return failure(404);
  const clientId = request.nextUrl.searchParams.get("client_id") || "";
  const redirectUri = request.nextUrl.searchParams.get("redirect_uri") || "";
  const state = request.nextUrl.searchParams.get("state") || "";
  if (!validateWaAuthorization({ clientId, redirectUri, state }, process.env.WA_EXTERNAL_CLIENT_ID || "")) return failure(400);
  const resume = "/auth/wa/authorize?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state });
  const session = await getLoginSession();
  if (!session) return NextResponse.redirect(new URL("/auth/sign-in?next=" + encodeURIComponent(resume), config.loginOrigin), { headers: noStore });
  if (!session.user.emailVerified) return failure(403);
  if (!session.mfaVerifiedAt) return NextResponse.redirect(new URL("/auth/mfa?next=" + encodeURIComponent(resume), config.loginOrigin), { headers: noStore });
  if (!await userByAuthUserId(session.user.id)) return NextResponse.redirect(new URL("/auth/access?next=" + encodeURIComponent(resume), config.loginOrigin), { headers: noStore });
  const now = Date.now();
  const challenge = seal({ session: session.sessionId, clientId, redirectUri, state, nonce: makeOpaqueCode(), iat: now, exp: now + 300000 }, secret, "wa-consent");
  const response = NextResponse.redirect(new URL("/auth/wa/confirm", config.loginOrigin), { headers: noStore });
  // The confirmation GET follows a cross-site navigation from Wrap Authority.
  // Lax permits that redirect; POST still requires origin, session and consent proof.
  response.cookies.set("__Host-wa_consent", challenge, { secure: true, httpOnly: true, sameSite: "lax", path: "/", maxAge: 300 });
  return response;
}
export async function POST(request: NextRequest) {
  const config = waClient(), secret = process.env.WA_EXTERNAL_CLIENT_SECRET;
  if (!config || !secret || secret.length < 32) return failure(503);
  if (request.headers.get("origin") !== config.loginOrigin) return failure(403);
  const token = request.cookies.get("__Host-wa_consent")?.value || "";
  const consent = open(token, secret, "wa-consent");
  const form = await request.formData().catch(() => null);
  const session = await getLoginSession();
  if (!consent || !session || !session.user.emailVerified || !form || consent.session !== session.sessionId || form.get("challenge") !== token ||
      form.get("consent") !== "yes" || typeof consent.clientId !== "string" || typeof consent.redirectUri !== "string" ||
      typeof consent.state !== "string" || !validateWaAuthorization({ clientId: consent.clientId, redirectUri: consent.redirectUri, state: consent.state }, process.env.WA_EXTERNAL_CLIENT_ID || "")) return failure(403);
  if (!(await allow("mfa", session.user.id))) return failure(429);
  if (!freshMfa(session.mfaVerifiedAt)) {
    const code = form.get("code");
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) return failure(403);
    try { await getAuth().api.mfaVerify({ body: { code }, headers: await headers() }); }
    catch { return failure(403); }
  }
  const account = await userByAuthUserId(session.user.id);
  if (!account || account.isService || account.deletedAt) return failure(403);
  // The existing ticket store supplies atomic one-time redemption.
  // Consent-cookie deletion prevents ordinary repeat submissions; a replayed
  // consent can mint only the same user's ticket and cannot link without WA's
  // separately single-use, session-bound request.
  const code = makeOpaqueCode();
  await mintTicket({ ticketHash: hashTicket(code), userId: account.id, audienceHost: config.audience,
    returnPath: "/", sourceAuthSessionId: session.sessionId, expiresAt: new Date(Date.now() + WA_CODE_LIFETIME_MS) });
  const callback = new URL(config.callback); callback.searchParams.set("code", code); callback.searchParams.set("state", consent.state);
  const response = NextResponse.redirect(callback, { status: 303, headers: noStore });
  response.cookies.delete("__Host-wa_consent"); return response;
}
