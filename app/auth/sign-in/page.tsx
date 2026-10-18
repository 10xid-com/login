import type { Metadata } from "next";
import { connection } from "next/server";
import { configuredProviders } from "@/lib/auth/auth";
import { nextQuery, safeNext } from "@/lib/auth/login";
import { requestSignInCodeAction, signInWithPasswordAction } from "../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../auth-card";
import { Hidden, Notice, ProviderButtons, TextLink } from "../flow-ui";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  invalid: "That email and password do not match an account that can sign in.",
  rate: "Too many attempts. Wait a few minutes and try again.",
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
  "switch-account": "You are signed out. Sign in with the address that has access, and you will go straight back to where you were going.",
  "signed-out-everywhere": "You are signed out on every device.",
};

/**
 * Sign in to 10XiD. Whatever the first step — password, emailed code, Google
 * or Microsoft — the next screen is always the authenticator app.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; email?: string; notice?: string; method?: string }>;
}) {
  await connection();
  const params = await searchParams;
  const next = safeNext(params.next);
  const error = params.error ? (ERRORS[params.error] ?? ERRORS.provider) : null;
  const notice = params.notice ? NOTICES[params.notice] : null;

  const withPassword = params.method === "password";
  const footer = (
    <>
      Invited and new here? <TextLink href={`/auth/sign-up${nextQuery(next)}`}>Create your sign-in</TextLink>
    </>
  );
  const emailField = (
    <>
      <label htmlFor="email" className={labelClass}>Email</label>
      <input id="email" name="email" type="email" autoComplete="username" required
        defaultValue={params.email ?? ""} placeholder="you@company.com" className={inputClass} />
    </>
  );

  // Code first: most sign-ins have no password, so a password box by default is
  // a field people cannot fill. Password is one link away for those who set one.
  if (!withPassword) {
    return (
      <AuthCard
        title="Sign in"
        intro="Enter your email and we'll send you a sign-in code. Your authenticator app is the second step."
        footer={footer}
      >
        {notice ? <Notice>{notice}</Notice> : null}
        <form action={requestSignInCodeAction}>
          <Hidden name="next" value={next} />
          {emailField}
          {error ? <FieldError>{error}</FieldError> : null}
          <SubmitButton>Email me a code</SubmitButton>
        </form>
        <div className="mt-4 text-sm">
          <TextLink href={`/auth/sign-in?method=password${params.email ? `&email=${encodeURIComponent(params.email)}` : ""}${nextQuery(next, "&")}`}>Use a password instead</TextLink>
        </div>
        <ProviderButtons providers={configuredProviders()} next={next} />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Sign in with your password"
      intro="Your authenticator app is the second step."
      footer={footer}
    >
      {notice ? <Notice>{notice}</Notice> : null}
      <form action={signInWithPasswordAction}>
        <Hidden name="next" value={next} />
        {emailField}
        <label htmlFor="password" className={`${labelClass} mt-4`}>Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required
          className={inputClass} />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Continue</SubmitButton>
      </form>
      <div className="mt-4 flex justify-between text-sm">
        <TextLink href={`/auth/sign-in${nextQuery(next)}`}>Email me a code instead</TextLink>
        <TextLink href="/auth/forgot-password">Forgot password?</TextLink>
      </div>
      <ProviderButtons providers={configuredProviders()} next={next} />
    </AuthCard>
  );
}
