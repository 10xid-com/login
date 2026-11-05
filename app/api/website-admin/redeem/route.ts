import { authSessionLive, redeemTicket, userById } from "@/lib/db/identity";
import { hashTicket } from "@/lib/auth/sso";
import { isUidSiteCaller } from "@/lib/auth/uid-sites";
import { websiteAdminAddress, websiteAdminSite, websiteAdminStamp, websiteAdminToken } from "@/lib/auth/website-admin";

const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const host = typeof body?.host === "string" ? body.host : "";
  if (!websiteAdminSite(host) || !isUidSiteCaller(host, request.headers.get("authorization"))) {
    return Response.json({ error: "Unknown website." }, { status: 401, headers });
  }
  const { ticket, verifier } = body;
  const expired = () => Response.json({ error: "Sign-in expired. Open website admin again." }, { status: 400, headers });
  if (typeof ticket !== "string" || typeof verifier !== "string" ||
      !websiteAdminToken.test(ticket) || !websiteAdminToken.test(verifier)) return expired();

  const challenge = hashTicket(verifier).toString("base64url");
  const redeemed = await redeemTicket(hashTicket(`website-admin:${ticket}:${challenge}`), host);
  if (!redeemed?.sourceAuthSessionId || !(await authSessionLive(redeemed.sourceAuthSessionId))) return expired();
  const user = await userById(redeemed.userId);
  const email = user && !user.isService ? await websiteAdminAddress(host, user.id) : null;
  if (!user || !email) return expired();
  return Response.json({
    email, name: user.fullName ?? "", stamp: websiteAdminStamp(host, user.id, redeemed.sourceAuthSessionId),
  }, { headers });
}
