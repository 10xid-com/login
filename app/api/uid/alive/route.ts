import { NextResponse, type NextRequest } from "next/server";
import { authSessionLive } from "@/lib/db/identity";
import { isUidSiteCaller, mayOpenUid } from "@/lib/auth/uid-sites";

/**
 * Is a UiD page's sign-in still good? Its server asks every few minutes
 * (lib/auth/uid-sites), so signing out here, a password reset or an
 * operator's revocation ends the UiD's session too, and so does taking the
 * address out of UID_SITES.
 *
 *   POST { host, session, email }   Authorization: Bearer <that UiD's secret>
 *   200  { alive: boolean }
 */
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { host?: unknown; session?: unknown; email?: unknown } | null;
  const host = typeof body?.host === "string" ? body.host.toLowerCase() : "";
  if (!isUidSiteCaller(host, request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not a UiD this sign-in knows." }, { status: 401, headers: NO_STORE });
  }
  const session = typeof body?.session === "string" ? body.session : "";
  const email = typeof body?.email === "string" ? body.email : "";
  const alive = Boolean(session) && session.length <= 256 && mayOpenUid(host, email) && (await authSessionLive(session));
  return NextResponse.json({ alive }, { headers: NO_STORE });
}
