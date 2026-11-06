"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { getAuth } from "@/lib/auth/auth";
import { allow } from "@/lib/auth/throttle";
import { assertLoginOrigin, getLoginSession } from "@/lib/auth/login";
import { attestFreshTotp, completeSigninLink, revokeSigninLink, startSigninLink } from "@/lib/db/signin-links";

/**
 * Verified sign-in links: server actions, used by the account page (see
 * docs/verified-signin-links.md). Each one re-confirms the authenticator for
 * the CURRENT session (fresh confirmation) and then calls the database
 * function, which independently checks the session is live and fresh. They
 * return a small result instead of redirecting so the one-time code is never put in a URL.
 */
const totp = z.string().trim().regex(/^\d{6}$/);
export type LinkActionResult = { ok: true; code?: string } | { ok: false; reason: string };

const refresh = () => { revalidatePath("/auth/account"); revalidatePath("/auth/pid"); };

async function freshConfirm(form: FormData, purpose: "start" | "complete" | "revoke"): Promise<{ sessionId: string; userId: string } | { reason: string }> {
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
  // The attestation is minted only after THIS action's TOTP passed, and is consumed by the one mutation.
  if (!(await attestFreshTotp(session.sessionId, purpose))) return { reason: "not_fresh" };
  return { sessionId: session.sessionId, userId: session.user.id };
}

/** Account A: begin. Returns the one-time code to type into account B's own sign-in. */
export async function startSigninLinkAction(form: FormData): Promise<LinkActionResult> {
  const step = await freshConfirm(form, "start");
  if ("reason" in step) return { ok: false, reason: step.reason };
  const recipient = z.string().trim().toLowerCase().max(320).email().safeParse(form.get("recipient"));
  if (!recipient.success) return { ok: false, reason: "recipient" };
  const side = form.get("primary") === "other" ? "redeemer" : "initiator";
  const result = await startSigninLink(step.sessionId, side, recipient.data);
  return result.ok ? { ok: true, code: result.code } : result;
}

/** Account B: in its own browser session, enter the code. */
export async function completeSigninLinkAction(form: FormData): Promise<LinkActionResult> {
  const step = await freshConfirm(form, "complete");
  if ("reason" in step) return { ok: false, reason: step.reason };
  const code = z.string().trim().max(16).safeParse(form.get("code"));
  if (!code.success) return { ok: false, reason: "invalid" };
  const result = await completeSigninLink(step.sessionId, code.data);
  if (result !== "linked") return { ok: false, reason: result };
  refresh();
  return { ok: true };
}

export async function revokeSigninLinkAction(form: FormData): Promise<LinkActionResult> {
  const step = await freshConfirm(form, "revoke");
  if ("reason" in step) return { ok: false, reason: step.reason };
  const id = z.string().uuid().safeParse(form.get("link"));
  if (!id.success) return { ok: false, reason: "invalid" };
  const result = await revokeSigninLink(step.sessionId, id.data);
  if (result !== "revoked") return { ok: false, reason: result };
  refresh();
  return { ok: true };
}
