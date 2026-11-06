"use server";

import { headers } from "next/headers";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { getAuth } from "@/lib/auth/auth";
import { allow } from "@/lib/auth/throttle";
import { assertLoginOrigin, getLoginSession } from "@/lib/auth/login";
import { completeSigninLink, revokeSigninLink, startSigninLink } from "@/lib/db/signin-links";

/**
 * Verified sign-in links: server actions. NOT yet wired to a page (see
 * docs/verified-signin-links.md). Each one re-confirms the authenticator for
 * the CURRENT session (fresh confirmation) and then calls the database
 * function, which independently checks the session is live and fresh. They
 * return a small result instead of redirecting so the one-time code is never put in a URL.
 */
const totp = z.string().trim().regex(/^\d{6}$/);
export type LinkActionResult = { ok: true; code?: string } | { ok: false; reason: string };

async function freshConfirm(form: FormData): Promise<{ sessionId: string; userId: string } | { reason: string }> {
  await assertLoginOrigin();
  const session = await getLoginSession();
  if (!session?.mfaVerifiedAt) return { reason: "sign_in" };
  if (!(await allow("signinLink", session.user.id))) return { reason: "rate" };
  const code = totp.safeParse(form.get("totp"));
  if (!code.success) return { reason: "totp" };
  try {
    await getAuth().api.mfaVerify({ body: { code: code.data }, headers: await headers() });
  } catch (error) {
    if (error instanceof APIError) return { reason: (error.body as { code?: string } | undefined)?.code === "MFA_LOCKED" ? "locked" : "totp" };
    throw error;
  }
  return { sessionId: session.sessionId, userId: session.user.id };
}

/** Account A: begin. Returns the one-time code to type into account B's own sign-in. */
export async function startSigninLinkAction(form: FormData): Promise<LinkActionResult> {
  const step = await freshConfirm(form);
  if ("reason" in step) return { ok: false, reason: step.reason };
  const side = form.get("primary") === "other" ? "redeemer" : "initiator";
  const result = await startSigninLink(step.sessionId, side);
  return result.ok ? { ok: true, code: result.code } : result;
}

/** Account B: in its own browser session, enter the code. */
export async function completeSigninLinkAction(form: FormData): Promise<LinkActionResult> {
  const step = await freshConfirm(form);
  if ("reason" in step) return { ok: false, reason: step.reason };
  const code = z.string().trim().max(16).safeParse(form.get("code"));
  if (!code.success) return { ok: false, reason: "invalid" };
  const result = await completeSigninLink(step.sessionId, code.data);
  return result === "linked" ? { ok: true } : { ok: false, reason: result };
}

export async function revokeSigninLinkAction(form: FormData): Promise<LinkActionResult> {
  const step = await freshConfirm(form);
  if ("reason" in step) return { ok: false, reason: step.reason };
  const id = z.string().uuid().safeParse(form.get("link"));
  if (!id.success) return { ok: false, reason: "invalid" };
  const result = await revokeSigninLink(step.sessionId, id.data);
  return result === "revoked" ? { ok: true } : { ok: false, reason: result };
}
