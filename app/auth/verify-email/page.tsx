import type { Metadata } from "next";
import { safeNext } from "@/lib/auth/login";
import { sendVerificationCodeAction, verifyEmailAction } from "../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../auth-card";
import { Hidden, Notice, SecondaryButton } from "../flow-ui";

export const metadata: Metadata = { title: "Confirm your email" };

const ERRORS: Record<string, string> = {
  email: "That does not look like an email address.",
  code: "That code is not right, or it has expired.",
};

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; email?: string; notice?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const error = params.error ? ERRORS[params.error] : null;
  const address = params.email ?? "";
  return (
    <AuthCard title="Confirm your email">
      {params.notice === "sent" && address ? (
        <Notice>If {address} has been invited to 10XiD, we have emailed it a six-digit code.</Notice>
      ) : null}
      <form action={verifyEmailAction}>
        <Hidden name="next" value={next} />
        <label htmlFor="email" className={labelClass}>Email</label>
        <input id="email" name="email" type="email" required defaultValue={address} className={inputClass} />
        <label htmlFor="code" className={`${labelClass} mt-4`}>Code</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}"
          maxLength={6} required className={inputClass} />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Confirm</SubmitButton>
      </form>
      <form action={sendVerificationCodeAction} className="mt-3">
        <Hidden name="next" value={next} />
        <Hidden name="email" value={address} />
        {address ? <SecondaryButton>Send a new code</SecondaryButton> : null}
      </form>
    </AuthCard>
  );
}
