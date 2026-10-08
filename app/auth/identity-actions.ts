"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { configuredProviders, getAuth, type SocialProvider } from "@/lib/auth/auth";
import { forgetRecoveryCodes, showRecoveryCodesOnce } from "@/lib/auth/recovery-codes-once";
import { allow } from "@/lib/auth/throttle";
import { rememberResume } from "@/lib/auth/resume";
import { isSpentCode, rememberSpentCode } from "@/lib/auth/spent-code";
import {
  assertLoginOrigin,
  getLoginSession,
  nextQuery,
  ownSignInSessions,
  resolveAccount,
  safeNext,
} from "@/lib/auth/login";
import {
  revokePortalSessionsForUser,
  revokePortalSessionsFromAuthSession,
  userByAuthUserId,
} from "@/lib/db/accounts";
import { consumeTicketsForAuthSession } from "@/lib/db/identity";
import { authDb } from "@/lib/db/auth-connection";
import { authUsers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { afterSignIn, portalReturnPath } from "@/lib/auth/sso";

/**
 * Every step of signing in on login.10xid.com, as server actions.
 *
 * Each one checks the request came from this host's own pages
 * (assertLoginOrigin) and counts against its rate limits (lib/auth/throttle —
 * Better Auth's own run only for HTTP calls), then calls Better Auth
 * in-process, so its cookies are set on the response by the nextCookies plugin. Errors come back to the page
 * as a short code in the query string; the pages turn codes into sentences, and
 * never say whether an address has an account.
 */

const email = z.string().trim().toLowerCase().email().max(320);
const password = z.string().min(12).max(128);
const otp = z.string().trim().regex(/^\d{6}$/);
const totp = z.string().trim().regex(/^\d{6}$/);
const recovery = z.string().trim().toLowerCase().regex(/^[a-z0-9]{5}-?[a-z0-9]{5}$/);

type Failure = { ok: false; code: string };
type Result<T> = { ok: true; value: T } | Failure;

async function call<T>(fn: (h: Headers) => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn(await headers()) };
  } catch (error) {
    if (error instanceof APIError) {
      const code = (error.body as { code?: string } | undefined)?.code ?? String(error.status);
      return { ok: false, code };
    }
    throw error;
  }
}

function to(path: string, params: Record<string, string | undefined>): never {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value && !(key === "next" && value === "/")) query.set(key, value);
  }
  const qs = query.toString();
  redirect(qs ? `${path}?${qs}` : path);
}

/* ------------------------------------------------------------------ */
/* First factor                                                        */
/* ------------------------------------------------------------------ */

export async function signInWithPasswordAction(form: FormData) {
  await assertLoginOrigin();
  const next = safeNext(form.get("next"));
  const address = email.safeParse(form.get("email"));
  const secret = z.string().min(1).max(128).safeParse(form.get("password"));
  if (!address.success || !secret.success) to("/auth/sign-in", { error: "invalid", next });
  if (!(await allow("password", address.data))) to("/auth/sign-in", { error: "rate", next });

  const result = await call((h) =>
    getAuth().api.signInEmail({ body: { email: address.data, password: secret.data }, headers: h }),
  );
  if (!result.ok) to("/auth/sign-in", { error: "invalid", next });
  to("/auth/mfa", { next });
}

export async function requestSignInCodeAction(form: FormData) {
  await assertLoginOrigin();
  const next = safeNext(form.get("next"));
  const address = email.safeParse(form.get("email"));
  if (!address.success) to("/auth/sign-in/code", { error: "email", next });
  const resend = form.get("resend") === "1";
  if (!(await allow("requestCode", address.data))) {
    to("/auth/sign-in/code", { email: resend ? address.data : undefined, error: "rate", next });
  }
  await rememberResume(next);

  // The same answer whether or not the address can sign in: an identity is
  // only ever created for an invited address (lib/auth/auth.ts), and the page
  // does not say which it was.
  const result = await call((h) =>
    getAuth().api.sendVerificationOTP({ body: { email: address.data, type: "sign-in" }, headers: h }),
  );
  if (!result.ok && (result.code === "TOO_MANY_REQUESTS" || result.code === "429")) {
    to("/auth/sign-in/code", { email: resend ? address.data : undefined, error: "rate", next });
  }
  to("/auth/sign-in/code", { email: address.data, next, notice: resend ? "resent" : undefined });
}

export async function signInWithCodeAction(form: FormData) {
  await assertLoginOrigin();
  const next = safeNext(form.get("next"));
  const address = email.safeParse(form.get("email"));
  const code = otp.safeParse(form.get("code"));
  if (!address.success) to("/auth/sign-in/code", { error: "email", next });
  if (!code.success) to("/auth/sign-in/code", { email: address.data, error: "code", next });
  if (!(await allow("useCode", address.data))) to("/auth/sign-in/code", { email: address.data, error: "rate", next });

  const result = await call((h) =>
    getAuth().api.signInEmailOTP({ body: { email: address.data, otp: code.data }, headers: h }),
  );
  if (!result.ok) {
    // NOT_INVITED lands here too, worded the same as a wrong code.
    to("/auth/sign-in/code", { email: address.data, error: "code", next });
  }
  await rememberSpentCode(code.data);
  to("/auth/mfa", { next });
}

export async function requestPasswordResetAction(form: FormData) {
  await assertLoginOrigin();
  const address = email.safeParse(form.get("email"));
  if (!address.success) to("/auth/forgot-password", { error: "email" });
  if (!(await allow("requestReset", address.data))) to("/auth/forgot-password", { error: "rate" });
  const result = await call((h) =>
    getAuth().api.requestPasswordResetEmailOTP({ body: { email: address.data }, headers: h }),
  );
  if (!result.ok && (result.code === "TOO_MANY_REQUESTS" || result.code === "429")) {
    to("/auth/forgot-password", { error: "rate" });
  }
  to("/auth/reset-password", { email: address.data, notice: form.get("resend") === "1" ? "resent" : undefined });
}

export async function resetPasswordAction(form: FormData) {
  await assertLoginOrigin();
  const address = email.safeParse(form.get("email"));
  const code = otp.safeParse(form.get("code"));
  const secret = password.safeParse(form.get("password"));
  if (!address.success) to("/auth/forgot-password", { error: "email" });
  if (!code.success) to("/auth/reset-password", { email: address.data, error: "code" });
  if (!secret.success) to("/auth/reset-password", { email: address.data, error: "password" });
  if (!(await allow("reset", address.data))) to("/auth/reset-password", { email: address.data, error: "rate" });

  const result = await call((h) =>
    getAuth().api.resetPasswordEmailOTP({
      body: { email: address.data, otp: code.data, password: secret.data },
      headers: h,
    }),
  );
  if (!result.ok) to("/auth/reset-password", { email: address.data, error: "code" });
  // Better Auth has removed every sign-in session of this identity
  // (revokeSessionsOnPasswordReset); the portal sessions go too, at once.
  await endPortalAccessForAddress(address.data);
  to("/auth/sign-in", { notice: "reset", email: address.data });
}

export async function signInWithProviderAction(form: FormData) {
  await assertLoginOrigin();
  const next = safeNext(form.get("next"));
  const provider = form.get("provider");
  if (!configuredProviders().includes(provider as SocialProvider)) to("/auth/sign-in", { error: "invalid", next });
  if (!(await allow("provider"))) to("/auth/sign-in", { error: "rate", next });

  const result = await call((h) =>
    getAuth().api.signInSocial({
      body: {
        provider: provider as SocialProvider,
        callbackURL: `/auth/mfa${nextQuery(next)}`,
        errorCallbackURL: `/auth/sign-in${nextQuery(next)}`,
        disableRedirect: true,
      },
      headers: h,
    }),
  );
  if (!result.ok || !result.value.url) to("/auth/sign-in", { error: "provider", next });
  redirect(result.value.url);
}

/* ------------------------------------------------------------------ */
/* The authenticator                                                   */
/* ------------------------------------------------------------------ */

export async function startEnrollmentAction(form: FormData) {
  await assertLoginOrigin();
  const next = safeNext(form.get("next"));
  const result = await call((h) => getAuth().api.mfaStartEnrollment({ headers: h }));
  if (!result.ok) {
    if (result.code === "MAILBOX_PROOF_REQUIRED") {
      const session = await getLoginSession();
      to("/auth/sign-in/code", { email: session?.user.email, notice: "prove", next });
    }
    if (result.code === "EMAIL_NOT_VERIFIED") to("/auth/access", { next });
    if (result.code === "MFA_ALREADY_ENROLLED") to("/auth/mfa", { next });
    to("/auth/sign-in", { next });
  }
  to("/auth/mfa/setup", { next });
}

export async function confirmEnrollmentAction(form: FormData) {
  await assertLoginOrigin();
  const next = safeNext(form.get("next"));
  const code = totp.safeParse(form.get("code"));
  if (!code.success) to("/auth/mfa/setup", { error: "code", next });
  if (await isSpentCode(code.data)) to("/auth/mfa/setup", { error: "emailed", next });
  const who = (await getLoginSession())?.user.id;
  if (!(await allow("mfa", who))) to("/auth/mfa/setup", { error: "rate", next });
  const result = await call((h) =>
    getAuth().api.mfaConfirmEnrollment({ body: { code: code.data }, headers: h }),
  );
  if (!result.ok) to("/auth/mfa/setup", { error: result.code === "MFA_INVALID_CODE" ? "code" : "expired", next });
  await settleAccount();
  await showRecoveryCodesOnce(result.value.recoveryCodes);
  to("/auth/mfa/recovery-codes", { next });
}

export async function verifyAuthenticatorAction(form: FormData) {
  await assertLoginOrigin();
  const next = safeNext(form.get("next"));
  const code = totp.safeParse(form.get("code"));
  if (!code.success) to("/auth/mfa", { error: "code", next });
  // The emailed code, offered again by the phone: say so, and don't count it
  // against the authenticator's lockout.
  if (await isSpentCode(code.data)) to("/auth/mfa", { error: "emailed", next });
  const who = (await getLoginSession())?.user.id;
  if (!(await allow("mfa", who))) to("/auth/mfa", { error: "rate", next });
  const result = await call((h) => getAuth().api.mfaVerify({ body: { code: code.data }, headers: h }));
  if (!result.ok) {
    if (result.code === "MFA_LOCKED") to("/auth/mfa", { error: "locked", next });
    if (result.code === "MFA_NOT_ENROLLED") to("/auth/mfa/setup", { next });
    if (result.code === "UNAUTHORIZED" || result.code === "401") to("/auth/sign-in", { next });
    to("/auth/mfa", { error: "code", next });
  }
  await finish(next);
}

/**
 * A fresh code for a sign-in that already passed the authenticator, for the
 * portal's 24-hour and five-minute rules. Back to the portal page it came from.
 */
export async function reverifyAuthenticatorAction(form: FormData) {
  await assertLoginOrigin();
  const back = portalReturnPath(form.get("return"));
  const again: (params: Record<string, string>) => never = (params) =>
    to("/auth/mfa/again", { ...params, return: back });
  const code = totp.safeParse(form.get("code"));
  if (!code.success) again({ error: "code" });
  const who = (await getLoginSession())?.user.id;
  if (!(await allow("mfa", who))) again({ error: "rate" });
  const result = await call((h) => getAuth().api.mfaVerify({ body: { code: code.data }, headers: h }));
  if (!result.ok) {
    if (result.code === "MFA_LOCKED") again({ error: "locked" });
    if (result.code === "UNAUTHORIZED" || result.code === "401") to("/auth/sign-in", {});
    again({ error: "code" });
  }
  redirect(afterSignIn(back));
}

export async function recoverWithCodeAction(form: FormData) {
  await assertLoginOrigin();
  const next = safeNext(form.get("next"));
  const code = recovery.safeParse(form.get("code"));
  if (!code.success) to("/auth/mfa/recover", { error: "code", next });
  const who = (await getLoginSession())?.user.id;
  if (!(await allow("mfa", who))) to("/auth/mfa/recover", { error: "rate", next });
  const result = await call((h) => getAuth().api.mfaRecover({ body: { code: code.data }, headers: h }));
  if (!result.ok) {
    to("/auth/mfa/recover", { error: result.code === "MFA_LOCKED" ? "locked" : "code", next });
  }
  await settleAccount();
  // Straight to the account page: a recovery code usually means the phone is
  // gone, and the authenticator should be replaced before anything else.
  to("/auth/account", { notice: "recovered", left: String(result.value.remaining ?? 0) });
}

export async function regenerateRecoveryCodesAction() {
  await assertLoginOrigin();
  const result = await call((h) => getAuth().api.mfaRegenerateRecoveryCodes({ headers: h }));
  if (!result.ok) to("/auth/account", { error: result.code === "MFA_NOT_FRESH" ? "fresh" : "failed" });
  await showRecoveryCodesOnce(result.value.recoveryCodes);
  to("/auth/mfa/recovery-codes", { next: "/auth/account" });
}

/** "I have saved them": forget the codes and carry on. */
export async function recoveryCodesSavedAction(form: FormData) {
  await assertLoginOrigin();
  const next = safeNext(form.get("next"));
  await forgetRecoveryCodes();
  if (next !== "/") redirect(next);
  await finish(next);
}

export async function resetAuthenticatorAction() {
  await assertLoginOrigin();
  const result = await call((h) => getAuth().api.mfaResetAuthenticator({ headers: h }));
  if (!result.ok) to("/auth/account", { error: result.code === "MFA_NOT_FRESH" ? "fresh" : "failed" });
  to("/auth/mfa/setup", { next: "/auth/account" });
}

/**
 * Add a password, or change it. A password is only ever set by somebody
 * already signed in with their authenticator — never at sign-up — so it can
 * never be planted on an address before its owner proves it. Adding one where
 * none exists needs the authenticator within ten minutes; changing one needs
 * the current password, and signs out every other session.
 */
export async function setPasswordAction(form: FormData) {
  await assertLoginOrigin();
  const session = await getLoginSession();
  if (!session?.mfaVerifiedAt) to("/auth/sign-in", { next: "/auth/account" });
  const fresh = Date.now() - session.mfaVerifiedAt.getTime() < 10 * 60 * 1000;
  const next = password.safeParse(form.get("password"));
  if (!next.success) to("/auth/account", { error: "password" });
  if (!(await allow("setPassword", session.user.id))) to("/auth/account", { error: "rate" });
  const current = z.string().min(1).max(128).safeParse(form.get("current"));

  const result = current.success
    ? await call((h) =>
        getAuth().api.changePassword({
          body: { currentPassword: current.data, newPassword: next.data, revokeOtherSessions: true },
          headers: h,
        }),
      )
    : fresh
      ? await call((h) => getAuth().api.setPassword({ body: { newPassword: next.data }, headers: h }))
      : ({ ok: false, code: "MFA_NOT_FRESH" } as const);
  if (!result.ok) to("/auth/account", { error: result.code === "MFA_NOT_FRESH" ? "fresh" : "current" });
  to("/auth/account", { notice: "password" });
}

/* ------------------------------------------------------------------ */
/* Access, sessions, signing out                                       */
/* ------------------------------------------------------------------ */

/** Tie the identity to a portal account if it can be. Only after the authenticator. */
async function settleAccount() {
  const session = await getLoginSession();
  if (!session?.mfaVerifiedAt) return null;
  return resolveAccount(session.user);
}

async function finish(next: string): Promise<never> {
  const outcome = await settleAccount();
  if (outcome === "bound" || outcome === "invitation_accepted") redirect(next);
  to("/auth/access", { next });
}

export async function checkAccessAction(form: FormData) {
  await assertLoginOrigin();
  const next = safeNext(form.get("next"));
  const session = await getLoginSession();
  if (!session) to("/auth/sign-in", { next });
  if (!session.mfaVerifiedAt) to("/auth/mfa", { next });
  await finish(next);
}

export async function linkProviderAction(form: FormData) {
  await assertLoginOrigin();
  const provider = form.get("provider");
  if (!configuredProviders().includes(provider as SocialProvider)) to("/auth/account", { error: "failed" });
  const result = await call((h) =>
    getAuth().api.linkSocialAccount({
      body: {
        provider: provider as SocialProvider,
        callbackURL: "/auth/account?notice=linked",
        errorCallbackURL: "/auth/account?error=link",
        disableRedirect: true,
      },
      headers: h,
    }),
  );
  if (!result.ok || !result.value.url) to("/auth/account", { error: "link" });
  redirect(result.value.url);
}

export async function revokeSessionAction(form: FormData) {
  await assertLoginOrigin();
  const id = z.string().min(1).max(200).safeParse(form.get("session"));
  const current = await getLoginSession();
  if (!current || !id.success) to("/auth/account", {});
  // The token is looked up here, by id, among the caller's own sessions: no
  // session token is ever put into a page.
  const target = (await ownSignInSessions(current.user.id)).find((s) => s.id === id.data);
  if (!target) to("/auth/account", { error: "failed" });
  await call((h) => getAuth().api.revokeSession({ body: { token: target.token }, headers: h }));
  await revokePortalSessionsFromAuthSession(target.id);
  await consumeTicketsForAuthSession(target.id);
  if (target.id === current.sessionId) to("/auth/sign-in", { notice: "signed-out" });
  to("/auth/account", { notice: "revoked" });
}

export async function signOutAction() {
  await assertLoginOrigin();
  const current = await getLoginSession();
  if (current) {
    await revokePortalSessionsFromAuthSession(current.sessionId);
    await consumeTicketsForAuthSession(current.sessionId);
  }
  await call((h) => getAuth().api.signOut({ headers: h }));
  to("/auth/sign-in", { notice: "signed-out" });
}

export async function signOutEverywhereAction() {
  await assertLoginOrigin();
  const current = await getLoginSession();
  if (!current) to("/auth/sign-in", {});
  for (const s of await ownSignInSessions(current.user.id)) await consumeTicketsForAuthSession(s.id);
  const account = await userByAuthUserId(current.user.id);
  if (account) await revokePortalSessionsForUser(account.id);
  await call((h) => getAuth().api.revokeSessions({ headers: h }));
  await call((h) => getAuth().api.signOut({ headers: h }));
  to("/auth/sign-in", { notice: "signed-out-everywhere" });
}

/** After a password reset: the portal sessions of the account this identity is bound to. */
async function endPortalAccessForAddress(address: string) {
  const [identity] = await authDb()
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, address))
    .limit(1);
  const account = identity ? await userByAuthUserId(identity.id) : null;
  if (account) await revokePortalSessionsForUser(account.id);
}
