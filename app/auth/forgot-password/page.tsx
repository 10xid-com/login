import type { Metadata } from "next";
import { requestPasswordResetAction } from "../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../auth-card";
import { TextLink } from "../flow-ui";

export const metadata: Metadata = { title: "Reset your password" };

const ERRORS: Record<string, string> = {
  email: "That does not look like an email address.",
  rate: "Too many requests. Wait a minute and try again.",
};

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const error = params.error ? ERRORS[params.error] : null;
  return (
    <AuthCard title="Reset your password"
      intro="We will email you a code. Resetting signs you out everywhere, and you will still need your authenticator."
      footer={<TextLink href="/auth/sign-in">Back to sign in</TextLink>}>
      <form action={requestPasswordResetAction}>
        <label htmlFor="email" className={labelClass}>Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required className={inputClass} />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Email me a code</SubmitButton>
      </form>
    </AuthCard>
  );
}
