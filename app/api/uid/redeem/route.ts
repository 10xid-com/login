import { NextResponse, type NextRequest } from "next/server";
import { redeemTicket, userById } from "@/lib/db/identity";
import { hashTicket } from "@/lib/auth/sso";
import { isUidSiteCaller, mayOpenUid } from "@/lib/auth/uid-sites";

/**
 * A UiD page's server redeems the ticket its visitor brought back
 * (app/auth/uid/authorize), and learns who signed in (lib/auth/uid-sites).
 *
 *   POST { host, ticket }   Authorization: Bearer <that UiD's secret>
 *   200  { email, name, session }   session: the sign-in it came from, for /api/uid/alive
 *
 * Only the UiD the ticket was minted for can redeem it, only once, within
 * its few seconds, and only while UID_SITES still lets the account open it.
 * Every failure is the same answer, so it says nothing about which check
 * failed.
 */
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { host?: unknown; ticket?: unknown } | null;
  const host = typeof body?.host === "string" ? body.host.toLowerCase() : "";
  const ticket = typeof body?.ticket === "string" ? body.ticket : "";
  if (!isUidSiteCaller(host, request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not a UiD this sign-in knows." }, { status: 401, headers: NO_STORE });
  }

  const redeemed = ticket.length >= 16 && ticket.length <= 128 ? await redeemTicket(hashTicket(ticket), host) : null;
  const user = redeemed ? await userById(redeemed.userId) : null;
  if (!redeemed || !user || user.isService || !mayOpenUid(host, user.email)) {
    return NextResponse.json({ error: "That sign-in has expired. Sign in again." }, { status: 400, headers: NO_STORE });
  }
  return NextResponse.json(
    { email: user.email.toLowerCase(), name: user.fullName ?? "", session: redeemed.sourceAuthSessionId },
    { headers: NO_STORE },
  );
}
