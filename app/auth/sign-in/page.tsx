import type { Metadata } from "next";
import { connection } from "next/server";
import { configuredProviders } from "@/lib/auth/auth";
import { nextQuery, safeNext } from "@/lib/auth/login";
import { signInWithPasswordAction } from "../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../auth-card";
import { Hidden, Notice, ProviderButtons, TextLink } from "../flow-ui";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  invalid: "That email and password do not match an account that can sign in.",
  rate: "Too many attempts. Wait a minute and try again.",
  provider: "That sign-in did not complete. Try again, or use another way to sign in.",
  account_not_linked:
    "That address already signs in another way. Sign in that way, then link the provider from your account.",
  NOT_INVITED: "That address has not been invited to 10XiD.",
  PROVIDER_EMAIL_UNVERIFIED:
    "Your provider did not confirm that address. Sign in with an emailed code first, then link the provider from your account.",
};

const NOTICES: Record<string, string> = {
  verified: "Your address is confirmed. Sign in to continue.",
  reset: "Your password has been changed and every session signed out. Sign in with the new one.",
  "signed-out": "You are signed out.",
  "signed-out-everywhere": "You are signed out on every device.",
};

/**
 * Sign in to 10XiD. Whatever the first step — password, emailed code, Google
 * or Microsoft — the next screen is always the authenticator app.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; email?: string; notice?: string }>;
}) {
  await connection();
  const params = await searchParams;
  const next = safeNext(params.next);
  const error = params.error ? (ERRORS[params.error] ?? ERRORS.provider) : null;
  const notice = params.notice ? NOTICES[params.notice] : null;

  return (
    <AuthCard
      title="Sign in"
      intro="Sign in with your password, an emailed code, or your work account. Your authenticator app is always the second step."
      footer={
        <>
          Invited and new here? <TextLink href={`/auth/sign-up${nextQuery(next)}`}>Create your sign-in</TextLink>
        </>
      }
    >
      {notice ? <Notice>{notice}</Notice> : null}
      <form action={signInWithPasswordAction}>
        <Hidden name="next" value={next} />
        <label htmlFor="email" className={labelClass}>Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required
          defaultValue={params.email ?? ""} placeholder="you@company.com" className={inputClass} />
        <label htmlFor="password" className={`${labelClass} mt-4`}>Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required
          className={inputClass} />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Continue</SubmitButton>
      </form>
      <div className="mt-4 flex justify-between text-sm">
        <TextLink href={`/auth/sign-in/code${nextQuery(next)}`}>Email me a code instead</TextLink>
        <TextLink href="/auth/forgot-password">Forgot password?</TextLink>
      </div>
      <ProviderButtons providers={configuredProviders()} next={next} />
    </AuthCard>
  );
}
