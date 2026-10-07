import type { Metadata } from "next";
import { requestPasswordResetAction, resetPasswordAction } from "../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../auth-card";
import { Hidden, Notice, SecondaryButton } from "../flow-ui";

export const metadata: Metadata = { title: "Choose a new password" };

const ERRORS: Record<string, string> = {
  rate: "Too many attempts. Wait a few minutes and try again.",
  code: "That code is not right, or it has expired.",
  password: "Choose a password of at least 12 characters.",
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; email?: string; notice?: string }>;
}) {
  const params = await searchParams;
  const error = params.error ? ERRORS[params.error] : null;
  const address = params.email ?? "";
  return (
    <AuthCard title="Choose a new password">
      {address ? (
        <Notice>
          {params.notice === "resent"
            ? `A new code is on its way to ${address}.`
            : `If ${address} has a sign-in, a code is on its way.`}
        </Notice>
      ) : null}
      <form action={resetPasswordAction}>
        <label htmlFor="email" className={labelClass}>Email</label>
        <input id="email" name="email" type="email" required defaultValue={address} className={inputClass} />
        <label htmlFor="code" className={`${labelClass} mt-4`}>Code</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}"
          maxLength={6} required className={inputClass} />
        <label htmlFor="password" className={`${labelClass} mt-4`}>New password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={12}
          maxLength={128} required className={inputClass} />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Change password</SubmitButton>
      </form>
      {address ? (
        <form action={requestPasswordResetAction} className="mt-3">
          <Hidden name="email" value={address} />
          <Hidden name="resend" value="1" />
          <SecondaryButton>Send a new code</SecondaryButton>
        </form>
      ) : null}
    </AuthCard>
  );
}
