import type { Metadata } from "next";
import { configuredProviders } from "@/lib/auth/auth";
import { nextQuery, safeNext } from "@/lib/auth/login";
import { signUpAction } from "../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../auth-card";
import { Hidden, ProviderButtons, TextLink } from "../flow-ui";

export const metadata: Metadata = { title: "Create your sign-in" };

const ERRORS: Record<string, string> = {
  invalid: "Enter your name and a valid email address.",
  password: "Choose a password of at least 12 characters.",
};

/**
 * For somebody who has been invited. Creating a sign-in grants nothing by
 * itself: the address has to be confirmed, an authenticator set up, and the
 * invitation (made out to exactly this address) is accepted only then.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const error = params.error ? ERRORS[params.error] : null;
  return (
    <AuthCard title="Create your sign-in"
      intro="Use the address your invitation was sent to. We will email a code to confirm it."
      footer={<>Already set up? <TextLink href={`/auth/sign-in${nextQuery(next)}`}>Sign in</TextLink></>}>
      <form action={signUpAction}>
        <Hidden name="next" value={next} />
        <label htmlFor="name" className={labelClass}>Name</label>
        <input id="name" name="name" autoComplete="name" required className={inputClass} />
        <label htmlFor="email" className={`${labelClass} mt-4`}>Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required className={inputClass} />
        <label htmlFor="password" className={`${labelClass} mt-4`}>Password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={12}
          maxLength={128} required className={inputClass} />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Create sign-in</SubmitButton>
      </form>
      <ProviderButtons providers={configuredProviders()} next={next} />
    </AuthCard>
  );
}
