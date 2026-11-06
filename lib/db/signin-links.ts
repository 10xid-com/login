import "server-only";
import { createHash, randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./connection";

/**
 * Verified sign-in links. All proof checking lives in the database functions of
 * migration 0062; this file only mints codes and calls them. A link is for
 * discovery (My Businesses) and never grants a role or permission.
 */
export type LinkStartResult = "started" | "no_session" | "not_fresh" | "unsettled" | "limit" | "invalid";
export type LinkCompleteResult = "linked" | "no_session" | "not_fresh" | "unsettled" | "limit" | "locked" | "same_account" | "exists" | "invalid";
export type LinkRevokeResult = "revoked" | "no_session" | "not_fresh" | "not_found";
export type SigninLink = { linkId: string; userId: string; email: string; name: string; primary: boolean; verifiedAt: string };

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const hashLinkCode = (code: string) => createHash("sha256").update(`signin-link:${code.replace(/[\s-]/g, "").toUpperCase()}`).digest("hex");
/** 10 characters (~50 bits) from an unambiguous alphabet, shown as XXXXX-XXXXX. */
export function newLinkCode(): string {
  const raw = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}
const one = async (query: ReturnType<typeof sql>) => String(((await db.execute(query)).rows[0] as Record<string, unknown>)?.r ?? "invalid");

/** Side A. Returns the code to show once, or the refusal. The code itself is never stored. */
export async function startSigninLink(sessionId: string, primarySide: "initiator" | "redeemer"):
  Promise<{ ok: true; code: string } | { ok: false; reason: LinkStartResult }> {
  const code = newLinkCode();
  const r = await one(sql`select signin_link_start(${sessionId}, ${hashLinkCode(code)}, ${primarySide}) as r`) as LinkStartResult;
  return r === "started" ? { ok: true, code } : { ok: false, reason: r };
}
/** Side B, from the other account's own session. */
export const completeSigninLink = async (sessionId: string, code: string) =>
  await one(sql`select signin_link_complete(${sessionId}, ${hashLinkCode(code)}) as r`) as LinkCompleteResult;
export const revokeSigninLink = async (sessionId: string, linkId: string) =>
  await one(sql`select signin_link_revoke(${sessionId}, ${linkId}::uuid) as r`) as LinkRevokeResult;

/** Direct, still-valid partners of an ALREADY authenticated account. Display only. */
export async function linksFor(userId: string): Promise<SigninLink[]> {
  const result = await db.execute(sql`select link_id::text, partner_user_id::text, partner_email, partner_name,
    partner_is_primary, verified_at from signin_links_for(${userId}::uuid)`);
  return result.rows.map((row: Record<string, unknown>) => ({ linkId: String(row.link_id), userId: String(row.partner_user_id),
    email: String(row.partner_email), name: String(row.partner_name), primary: row.partner_is_primary === true,
    verifiedAt: new Date(String(row.verified_at)).toISOString() }));
}
