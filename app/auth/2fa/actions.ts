"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  RECOVERY_FLASH_COOKIE,
  issueRecoveryCodes,
} from "@/lib/auth/recovery";
import {
  confirmTotp,
  markSecondFactorPassed,
  setTotpSecret,
  userById,
} from "@/lib/db/identity";
import { getSessionContext } from "@/lib/auth/session";
import { refuseWhileActingAs } from "@/lib/auth/require";
import { afterSignIn, safePath } from "@/lib/auth/sso";
import {
  decryptSecret,
  encryptSecret,
  generateSecret,
  verifyCode,
} from "@/lib/auth/totp";

const codeSchema = z.string().trim().regex(/^\d{6}$/);

/**
 * Enrol, or verify. One action, because from the person's side it is one
 * screen: they either have an authenticator set up or they are setting one up.
 */
export async function verifySecondFactorAction(formData: FormData) {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/auth/login");

  // An authenticator enrolled while acting as somebody would still be enrolled
  // an hour later, on their account, under our phone. That is the takeover this
  // must not be a route to — see requireOwnAccount in lib/auth/require.ts.
  refuseWhileActingAs(ctx);

  // Only staff carry a second factor. A client reaching this form has nothing
  // to do here.
  if (ctx.role !== "staff") redirect("/jobs");

  const next = safePath(formData.get("next"));
  const back = (err: string) =>
    `/auth/2fa?next=${encodeURIComponent(next)}&error=${err}`;

  const parsed = codeSchema.safeParse(formData.get("code"));
  if (!parsed.success) redirect(back("format"));

  const user = await userById(ctx.userId);
  if (!user?.totpSecret) redirect(back("notset"));

  const secret = decryptSecret(user.totpSecret);
  if (!verifyCode(secret, parsed.data)) {
    redirect(back("wrong"));
  }

  // The first accepted code confirms the enrolment as well as the session.
  const firstTime = !user.totpConfirmedAt;
  if (firstTime) await confirmTotp(user.id);
  await markSecondFactorPassed(ctx.sessionId);

  /**
   * Confirming enrolment is the moment the emailed code STOPS working for this
   * account — from here on the authenticator is the way in. So it is also the
   * moment recovery codes have to exist, because a lost phone would otherwise
   * be a permanent lockout on the account that reaches every client.
   *
   * Not optional and not a later reminder: issued here, shown immediately.
   */
  if (firstTime) {
    await stashCodesForOneViewing(await issueRecoveryCodes(user.id));
    redirect(`/auth/recovery-codes?next=${encodeURIComponent(next)}`);
  }

  // Land where they were originally heading, not on a fixed page.
  redirect(afterSignIn(next));
}

/**
 * Hand the freshly issued codes to the screen that shows them.
 *
 * It is the person's own browser, the cookie cannot be read by script, it is
 * cleared the moment they acknowledge the screen, and it lapses on its own in
 * five minutes either way. The name lives in lib/auth/recovery.ts, because a
 * "use server" module may only export async functions.
 */
async function stashCodesForOneViewing(codes: string[]) {
  const jar = await cookies();
  jar.set(RECOVERY_FLASH_COOKIE, codes.join(" "), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SESSION_COOKIE_SECURE !== "false",
    path: "/auth",
    maxAge: 300,
  });
}

/**
 * A fresh set, replacing whatever is left.
 *
 * Needed after using one — or after losing the piece of paper. Requires a live,
 * fully authenticated session, so it is not a way in for anyone who has not
 * already proved who they are.
 */
export async function regenerateRecoveryCodesAction(formData: FormData) {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/auth/login");
  // Recovery codes are the way PAST the second factor. Reading somebody else's
  // set is walking away with their account in your pocket.
  refuseWhileActingAs(ctx);
  if (ctx.needsSecondFactor) redirect("/auth/2fa");

  const user = await userById(ctx.userId);
  if (!user?.totpConfirmedAt) redirect("/auth/2fa");

  await stashCodesForOneViewing(await issueRecoveryCodes(user.id));
  redirect(
    `/auth/recovery-codes?next=${encodeURIComponent(safePath(formData.get("next")))}`,
  );
}

/** Acknowledged and written down: drop the carrier and get on with it. */
export async function acknowledgeRecoveryCodesAction(formData: FormData) {
  const next = safePath(formData.get("next"));
  const jar = await cookies();
  jar.set(RECOVERY_FLASH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SESSION_COOKIE_SECURE !== "false",
    path: "/auth",
    maxAge: 0,
  });
  redirect(afterSignIn(next));
}

/**
 * Issue a fresh secret.
 *
 * Only possible while the account has no CONFIRMED secret. Otherwise anyone who
 * reached a half-authenticated session could replace the second factor with
 * their own, which would make it decorative — resetting a confirmed one is
 * deliberately an out-of-band task, not a button on this page.
 */
export async function beginEnrolmentAction(formData: FormData) {
  const next = safePath(formData.get("next"));
  const ctx = await getSessionContext();
  if (!ctx) redirect("/auth/login");
  refuseWhileActingAs(ctx);
  if (ctx.role !== "staff") redirect("/jobs");

  const user = await userById(ctx.userId);
  if (user?.totpConfirmedAt) redirect("/auth/2fa?error=already");

  await setTotpSecret(ctx.userId, encryptSecret(generateSecret()));
  redirect(`/auth/2fa?next=${encodeURIComponent(next)}`);
}
