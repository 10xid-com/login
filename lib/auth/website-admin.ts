import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { accountAddresses } from "@/lib/db/accounts";
import { editableCid } from "@/lib/db/cid-profiles";
import { authSessionLive, userById } from "@/lib/db/identity";
import { MemberError } from "@/lib/uid/member-policy";
import { uidAddress } from "./uid-sites";

const sites = {
  "wrapauthority.net": { slug: "wrapauthority", callback: "/api/auth/10xid" },
} as const;

export function websiteAdminSite(host: string) {
  return Object.hasOwn(sites, host) ? sites[host as keyof typeof sites] : null;
}

export const websiteAdminToken = /^[A-Za-z0-9_-]{43}$/;
export const websiteAdminStampPrefix = "web-admin.";

export async function websiteAdminAddress(host: string, userId: string) {
  const site = websiteAdminSite(host);
  if (!site) return null;
  try {
    await editableCid(site.slug, userId);
  } catch (error) {
    if (error instanceof MemberError) return null;
    throw error;
  }
  return uidAddress(host, await accountAddresses(userId));
}

export function websiteAdminStamp(host: string, userId: string, sessionId: string) {
  const key = process.env.UID_SITE_KEY;
  if (!key || key.length < 32) throw new Error("Website admin sign-in is unavailable.");
  const payload = Buffer.from(JSON.stringify([userId, sessionId])).toString("base64url");
  const signature = createHmac("sha256", key).update(`website-admin:${host}:${payload}`).digest("base64url");
  return `${websiteAdminStampPrefix}${payload}.${signature}`;
}

export async function websiteAdminLive(host: string, email: string, stamp: string) {
  const match = /^web-admin\.([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/.exec(stamp);
  if (!match || !websiteAdminSite(host)) return false;
  let userId: string;
  let sessionId: string;
  try {
    [userId, sessionId] = JSON.parse(Buffer.from(match[1], "base64url").toString());
    if (typeof userId !== "string" || typeof sessionId !== "string") return false;
    const expected = websiteAdminStamp(host, userId, sessionId);
    const given = Buffer.from(stamp);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return false;
  } catch {
    return false;
  }
  if (!(await authSessionLive(sessionId))) return false;
  const user = await userById(userId);
  if (!user || user.isService) return false;
  return (await websiteAdminAddress(host, userId)) === email;
}
