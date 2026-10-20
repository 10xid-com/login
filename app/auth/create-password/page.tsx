import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLoginSession, nextQuery, safeNext } from "@/lib/auth/login";
import { createPasswordAction } from "../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../auth-card";
import { Hidden } from "../flow-ui";

export const metadata: Metadata = { title: "Create your password" };

const ERRORS: Record<string, string> = {
  password: "Choose a password of at least 12 characters.",
  match: "The two passwords are not the same.",
  rate: "Too many attempts. Wait a few minutes and try again.",
  fresh: "That took a while. Add your password from Account settings instead.",
  failed: "That did not work. Try again.",
};

/** The last step of setting up a sign-in (after the recovery codes). */
export default async function CreatePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const session = await getLoginSession();
  if (!session?.mfaVerifiedAt) redirect(`/auth/sign-in${nextQuery(next)}`);
  const error = params.error ? ERRORS[params.error] : null;

  return (
    <AuthCard title="Create your password"
      intro={`For signing in as ${session.user.email}. Your authenticator app is still asked for every time.`}>
      <form action={createPasswordAction}>
        <Hidden name="next" value={next} />
        <input type="text" name="username" autoComplete="username" value={session.user.email} readOnly hidden />
        <label htmlFor="password" className={labelClass}>Password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128}
          required className={inputClass} />
        <label htmlFor="confirm" className={`${labelClass} mt-3`}>Type it again</label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} maxLength={128}
          required className={inputClass} />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Save password and continue</SubmitButton>
      </form>
      <form action={createPasswordAction} className="mt-3 text-center">
        <Hidden name="next" value={next} />
        <Hidden name="skip" value="1" />
        <button type="submit" className="text-sm font-medium text-ink-soft hover:underline">Skip for now</button>
      </form>
    </AuthCard>
  );
}
