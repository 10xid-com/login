import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { authenticatorState, getLoginSession, nextQuery } from "@/lib/auth/login";
import { reverifyAuthenticatorAction, signOutAction } from "../../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../../auth-card";
import { Hidden } from "../../flow-ui";
import { portalReturnPath } from "@/lib/auth/sso";

export const metadata: Metadata = { title: "Confirm it is you" };

const ERRORS: Record<string, string> = {
  rate: "Too many attempts. Wait a few minutes and try again.",
  code: "That code is not right. Use the current code from your authenticator app.",
  locked: "Too many incorrect codes. Try again in 15 minutes.",
};

/**
 * A fresh authenticator code for a sign-in that already has one.
 *
 * The portal asks for this before a step that must be recent: using agency
 * access needs the authenticator within 24 hours, and deciding on agency
 * access within five minutes. The code refreshes this sign-in's
 * authenticator time (the mfa gate), and the person goes back to the portal
 * page they came from.
 */
export default async function MfaAgainPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; return?: string }>;
}) {
  const params = await searchParams;
  const back = portalReturnPath(params.return);
  const session = await getLoginSession();
  if (!session) redirect(`/auth/sign-in${nextQuery("/")}`);
  if (!session.mfaVerifiedAt) redirect(`/auth/mfa${nextQuery("/")}`);
  const factor = await authenticatorState(session.user.id);
  if (factor.state !== "enrolled") redirect("/auth/mfa/setup");

  const error = params.error ? ERRORS[params.error] : null;
  return (
    <AuthCard title="Confirm it is you"
      intro={`Signed in as ${session.user.email}. This step needs a recent code: enter the current one from your authenticator app.`}>
      <form action={reverifyAuthenticatorAction}>
        <Hidden name="return" value={back} />
        <label htmlFor="code" className={labelClass}>Code</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="off" pattern="\d{6}"
          maxLength={6} required autoFocus className={inputClass} />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Confirm</SubmitButton>
      </form>
      <form action={signOutAction} className="mt-4 text-center">
        <button type="submit" className="text-sm text-ink-soft underline-offset-2 hover:underline">
          Not you? Sign out
        </button>
      </form>
    </AuthCard>
  );
}
