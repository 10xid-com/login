import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { checkSitePassword } from "@/lib/auth/site-password";
import { allow } from "@/lib/auth/throttle";
import { isUidSiteCaller } from "@/lib/auth/uid-sites";

/**
 * Another site's sign-in form checks a 10XiD password (lib/auth/site-password).
 *
 *   POST { host, email, password }   Authorization: Bearer <that site's secret>
 *   200  { email, name, stamp }      stamp: for /api/uid/alive
 *
 * Only a site UID_SITES lists can ask, only for the addresses listed for it,
 * and only so many times per address. Every refusal is the same answer, so
 * it says nothing about which check failed.
 */
const NO_STORE = { "Cache-Control": "no-store" };

const body = z.object({
  host: z.string().max(253),
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

export async function POST(request: NextRequest) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  const host = parsed.success ? parsed.data.host.toLowerCase() : "";
  if (!isUidSiteCaller(host, request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not a site this sign-in knows." }, { status: 401, headers: NO_STORE });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "That email and password do not match." }, { status: 400, headers: NO_STORE });
  }
  if (!(await allow("sitePassword", parsed.data.email, request.headers))) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429, headers: NO_STORE });
  }

  const signedIn = await checkSitePassword(host, parsed.data.email, parsed.data.password);
  if (!signedIn) {
    return NextResponse.json({ error: "That email and password do not match." }, { status: 400, headers: NO_STORE });
  }
  return NextResponse.json(signedIn, { headers: NO_STORE });
}
