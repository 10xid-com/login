import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { authenticatorState, getLoginSession, nextQuery, safeNext } from "@/lib/auth/login";
import { signOutAction, verifyAuthenticatorAction } from "../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../auth-card";
import { Hidden, TextLink } from "../flow-ui";

export const metadata: Metadata = { title: "Authenticator code" };

const ERRORS: Record<string, string> = {
  code: "That code is not right. Use the current code from your authenticator app.",
  locked: "Too many incorrect codes. Try again in 15 minutes, or use a recovery code.",
};

/**
 * The second step after every way of signing in. Reading only: the code is
 * checked by a POST (verifyAuthenticatorAction).
 */
export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const session = await getLoginSession();
  if (!session) redirect(`/auth/sign-in${nextQuery(next)}`);
  if (session.mfaVerifiedAt) redirect(`/auth/access${nextQuery(next)}`);
  if (!session.user.emailVerified) redirect(`/auth/access${nextQuery(next)}`);
  const factor = await authenticatorState(session.user.id);
  if (factor.state !== "enrolled") redirect(`/auth/mfa/setup${nextQuery(next)}`);

  const error = params.error ? ERRORS[params.error] : null;
  return (
    <AuthCard title="Enter your authenticator code"
      intro={`Signed in as ${session.user.email}. Open your authenticator app and enter the six-digit code for 10XiD.`}
      footer={
        <>
          Lost your phone? <TextLink href={`/auth/mfa/recover${nextQuery(next)}`}>Use a recovery code</TextLink>
        </>
      }>
      <form action={verifyAuthenticatorAction}>
        <Hidden name="next" value={next} />
        <label htmlFor="code" className={labelClass}>Code</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}"
          maxLength={6} required autoFocus className={inputClass} />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Verify</SubmitButton>
      </form>
      <form action={signOutAction} className="mt-4 text-center">
        <button type="submit" className="text-sm text-ink-soft underline-offset-2 hover:underline">
          Not you? Sign out
        </button>
      </form>
    </AuthCard>
  );
}
