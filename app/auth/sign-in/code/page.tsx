import type { Metadata } from "next";
import { nextQuery } from "@/lib/auth/login";
import { resumeFor } from "@/lib/auth/resume";
import { requestSignInCodeAction, signInWithCodeAction } from "../../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../../auth-card";
import { Hidden, Notice, SecondaryButton, TextLink } from "../../flow-ui";

export const metadata: Metadata = { title: "Sign in with a code" };

const ERRORS: Record<string, string> = {
  email: "That does not look like an email address.",
  code: "That code is not right, or it has expired. Codes last ten minutes.",
  rate: "Too many codes requested. Wait a few minutes and try again.",
};

/** Passwordless: a six-digit code by email, then the authenticator. */
export default async function SignInCodePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; email?: string; notice?: string }>;
}) {
  const params = await searchParams;
  const next = await resumeFor(params.next);
  // A refused code says which address it was checked against: a page left
  // open on another device may be for a different one.
  const error = params.error === "code" && params.email
    ? `That code is not right for ${params.email}, or it has expired. Codes last ten minutes.`
    : params.error ? ERRORS[params.error] : null;

  if (!params.email || params.notice === "prove") {
    return (
      <AuthCard title="Sign in with a code"
        intro={params.notice === "prove"
          ? "Before setting up an authenticator, prove this address is yours: we will email you a six-digit code."
          : "We will email you a six-digit code."}
        footer={<TextLink href={`/auth/sign-in${nextQuery(next)}`}>Back to sign in</TextLink>}>
        <form action={requestSignInCodeAction}>
          <Hidden name="next" value={next} />
          <label htmlFor="email" className={labelClass}>Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required
            defaultValue={params.email ?? ""} placeholder="you@company.com" className={inputClass} />
          {error ? <FieldError>{error}</FieldError> : null}
          <SubmitButton>Email me a code</SubmitButton>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Check your email"
      footer={<TextLink href={`/auth/sign-in/code${nextQuery(next)}`}>Use a different address</TextLink>}>
      <Notice>
        {params.notice === "resent"
          ? `The code is on its way to ${params.email} again: the same code, good for ten more minutes.`
          : `If ${params.email} can sign in to 10XiD, a code is on its way. It lasts ten minutes, and works on any device.`}
      </Notice>
      <form action={signInWithCodeAction}>
        <Hidden name="next" value={next} />
        {/* Shown, and can be changed: the code is the address's, so this page
            works for it on any device, whichever one asked for the code. */}
        <label htmlFor="email" className={labelClass}>Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required
          defaultValue={params.email} className={inputClass} />
        <label htmlFor="code" className={`${labelClass} mt-4`}>Code</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}"
          maxLength={6} required autoFocus className={inputClass} />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Continue</SubmitButton>
      </form>
      <form action={requestSignInCodeAction} className="mt-3">
        <Hidden name="next" value={next} />
        <Hidden name="email" value={params.email} />
        <Hidden name="resend" value="1" />
        <SecondaryButton>Email the code again</SecondaryButton>
      </form>
    </AuthCard>
  );
}
