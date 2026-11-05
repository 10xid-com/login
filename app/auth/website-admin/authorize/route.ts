import { type NextRequest } from "next/server";
import { userByAuthUserId } from "@/lib/db/accounts";
import { mintTicket } from "@/lib/db/identity";
import { getLoginSession } from "@/lib/auth/login";
import { SSO_TICKET_TTL_SECONDS } from "@/lib/auth/policy";
import { hashTicket, isPrimaryHost, originFor } from "@/lib/auth/sso";
import { uidSiteSecret, uidSites } from "@/lib/auth/uid-sites";
import { websiteAdminAddress, websiteAdminSite, websiteAdminToken } from "@/lib/auth/website-admin";
import { secretToken } from "@/lib/ids";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export async function GET(request: NextRequest) {
  const loginHost = (request.headers.get("host") ?? "").toLowerCase();
  if (!isPrimaryHost(loginHost)) return new Response("Not found.", { status: 404, headers });
  const params = request.nextUrl.searchParams;
  const host = params.get("host") ?? "";
  const challenge = params.get("challenge") ?? "";
  const site = websiteAdminSite(host);
  if (!site || !uidSites().has(host) || !uidSiteSecret(host) || !websiteAdminToken.test(challenge)) {
    return new Response("Website admin sign-in is unavailable.", { status: 400, headers });
  }

  const resume = `/auth/website-admin/authorize?${new URLSearchParams({ host, challenge })}`;
  const redirect = (url: URL) => new Response(null, { status: 303, headers: { ...headers, Location: url.href } });
  const here = (path: string) => {
    const url = new URL(path, originFor(loginHost));
    url.searchParams.set("next", resume);
    return redirect(url);
  };
  const session = await getLoginSession();
  if (!session) return here("/auth/sign-in");
  if (!session.mfaVerifiedAt) return here("/auth/mfa");
  const account = await userByAuthUserId(session.user.id);
  if (!account) return here("/auth/access");
  if (!(await websiteAdminAddress(host, account.id))) return here("/auth/uid/denied");

  const ticket = secretToken(32);
  await mintTicket({
    ticketHash: hashTicket(`website-admin:${ticket}:${challenge}`),
    userId: account.id,
    audienceHost: host,
    returnPath: "/admin",
    sourceAuthSessionId: session.sessionId,
    expiresAt: new Date(Date.now() + SSO_TICKET_TTL_SECONDS * 1000),
  });
  const callback = new URL(site.callback, `https://${host}`);
  callback.searchParams.set("ticket", ticket);
  callback.searchParams.set("state", challenge);
  return redirect(callback);
}
