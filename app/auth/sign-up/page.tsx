import type { Metadata } from "next";
import { configuredProviders } from "@/lib/auth/auth";
import { nextQuery, safeNext } from "@/lib/auth/login";
import { requestSignInCodeAction } from "../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../auth-card";
import { Hidden, ProviderButtons, TextLink } from "../flow-ui";

export const metadata: Metadata = { title: "Create your sign-in" };

/**
 * For somebody who has been invited. The first sign-in is always a proof of
 * the mailbox — an emailed code, or Google / Microsoft vouching for the
 * address — so nobody can claim an invited address before its owner does.
 * A password can be added afterwards, from "Your sign-in". Creating a sign-in
 * grants nothing by itself: the authenticator comes next, and the invitation
 * (made out to exactly this address) is accepted only then.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const error = params.error === "email" ? "That does not look like an email address." : null;
  return (
    <AuthCard title="Create your sign-in"
      intro="Use the address your invitation was sent to. We will email you a code to prove it is yours; you can add a password afterwards."
      footer={<>Already set up? <TextLink href={`/auth/sign-in${nextQuery(next)}`}>Sign in</TextLink></>}>
      <form action={requestSignInCodeAction}>
        <Hidden name="next" value={next} />
        <label htmlFor="email" className={labelClass}>Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required className={inputClass} />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Email me a code</SubmitButton>
      </form>
      <ProviderButtons providers={configuredProviders()} next={next} />
    </AuthCard>
  );
}
