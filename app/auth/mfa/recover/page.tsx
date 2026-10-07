import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLoginSession, nextQuery, safeNext } from "@/lib/auth/login";
import { recoverWithCodeAction } from "../../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../../auth-card";
import { Hidden, TextLink } from "../../flow-ui";

export const metadata: Metadata = { title: "Use a recovery code" };

const ERRORS: Record<string, string> = {
  rate: "Too many attempts. Wait a few minutes and try again.",
  code: "That recovery code is not right, or has been used.",
  locked: "Too many incorrect codes. Try again in 15 minutes.",
};

export default async function RecoverPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const session = await getLoginSession();
  if (!session) redirect(`/auth/sign-in${nextQuery(next)}`);
  const error = params.error ? ERRORS[params.error] : null;
  return (
    <AuthCard title="Use a recovery code"
      intro="Enter one of the recovery codes you saved when you set up your authenticator. Each works once."
      footer={<>No codes left? Ask your 10XiD administrator to reset your authenticator. <TextLink href={`/auth/mfa${nextQuery(next)}`}>Back</TextLink></>}>
      <form action={recoverWithCodeAction}>
        <Hidden name="next" value={next} />
        <label htmlFor="code" className={labelClass}>Recovery code</label>
        <input id="code" name="code" autoComplete="off" required placeholder="xxxxx-xxxxx" className={inputClass} />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Continue</SubmitButton>
      </form>
    </AuthCard>
  );
}
