import "server-only";
import { createHash, randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import { authDb } from "./auth-connection";

/**
 * Verified sign-in links. All proof checking lives in the database functions of
 * migrations 0062 and 0064; this file only mints codes and calls them. A link is for
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
// Every call runs on the portal_auth pool (authDb): portal_app has no EXECUTE on these functions.
const one = async (query: ReturnType<typeof sql>) => String(((await authDb().execute(query)).rows[0] as Record<string, unknown>)?.r ?? "invalid");
/** Mint the single-use proof for ONE mutation. Call only right after the action's own TOTP check succeeded. */
export async function attestFreshTotp(sessionId: string, purpose: "start" | "complete" | "revoke"): Promise<boolean> {
  return (await authDb().execute(sql`select signin_link_attest(${sessionId}, ${purpose}) as r`)).rows[0]?.r === true;
}

/** Side A, for the verified address of the intended second account. Unknown addresses look identical. Returns the code to show once, or the refusal. The code itself is never stored. */
export async function startSigninLink(sessionId: string, primarySide: "initiator" | "redeemer", recipientEmail: string):
  Promise<{ ok: true; code: string } | { ok: false; reason: LinkStartResult }> {
  const code = newLinkCode();
  const r = await one(sql`select signin_link_start(${sessionId}, ${hashLinkCode(code)}, ${primarySide}, ${recipientEmail}) as r`) as LinkStartResult;
  return r === "started" ? { ok: true, code } : { ok: false, reason: r };
}
/** Side B, from the other account's own session. */
export const completeSigninLink = async (sessionId: string, code: string) =>
  await one(sql`select signin_link_complete(${sessionId}, ${hashLinkCode(code)}) as r`) as LinkCompleteResult;
export const revokeSigninLink = async (sessionId: string, linkId: string) =>
  await one(sql`select signin_link_revoke(${sessionId}, ${linkId}::uuid) as r`) as LinkRevokeResult;

/** Direct, still-valid partners of an ALREADY authenticated account. Display only. */
export async function linksFor(userId: string): Promise<SigninLink[]> {
  const result = await authDb().execute(sql`select link_id::text, partner_user_id::text, partner_email, partner_name,
    partner_is_primary, verified_at from signin_links_for(${userId}::uuid)`);
  return result.rows.map((row: Record<string, unknown>) => ({ linkId: String(row.link_id), userId: String(row.partner_user_id),
    email: String(row.partner_email), name: String(row.partner_name), primary: row.partner_is_primary === true,
    verifiedAt: new Date(String(row.verified_at)).toISOString() }));
}

/** True if this pair has ever had a verified link, active or revoked. Blocks the legacy fallback for good. */
export async function pairHasLinkHistory(userId: string, otherId: string): Promise<boolean> {
  const result = await authDb().execute(sql`select signin_link_pair_history(${userId}::uuid, ${otherId}::uuid) as r`);
  return (result.rows[0] as Record<string, unknown> | undefined)?.r === true;
}
