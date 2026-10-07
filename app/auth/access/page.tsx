import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { accountStatus, getLoginSession, nextQuery, safeNext } from "@/lib/auth/login";
import { checkAccessAction, sendVerificationCodeAction, signOutAction } from "../identity-actions";
import { AuthCard, SubmitButton } from "../auth-card";
import { Hidden, SecondaryButton } from "../flow-ui";

export const metadata: Metadata = { title: "Access" };

/**
 * Signed in, and the authenticator passed — but signing in grants nothing by
 * itself. This says what is still missing, and offers to check again.
 */
export default async function AccessPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const session = await getLoginSession();
  if (!session) redirect(`/auth/sign-in${nextQuery(next)}`);
  const status = await accountStatus(session.user);

  if (status === "unverified") {
    return (
      <AuthCard title="Confirm your email" intro={`We need to confirm ${session.user.email} before going further.`}>
        <form action={sendVerificationCodeAction}>
          <Hidden name="next" value={next} />
          <Hidden name="email" value={session.user.email} />
          <SubmitButton>Email me a code</SubmitButton>
        </form>
      </AuthCard>
    );
  }
  if (!session.mfaVerifiedAt) redirect(`/auth/mfa${nextQuery(next)}`);

  const copy =
    status === "bound"
      ? { title: "You are signed in", intro: "Continue to 10XiD." }
      : status === "pending_binding"
        ? {
            title: "Waiting for confirmation",
            intro: `An account for ${session.user.email} exists from before. For your security, a 10XiD administrator confirms that this sign-in is yours before it opens that account. You will be able to continue once they have.`,
          }
        : {
            title: "No access yet",
            intro: `${session.user.email} is signed in, but it has no 10XiD account and no open invitation. If you were invited under another address, sign out and use that one.`,
          };

  return (
    <AuthCard title={copy.title} intro={copy.intro}>
      <form action={checkAccessAction}>
        <Hidden name="next" value={next} />
        <SubmitButton>{status === "bound" ? "Continue" : "Check again"}</SubmitButton>
      </form>
      <form action={signOutAction} className="mt-3">
        <SecondaryButton>Sign out</SecondaryButton>
      </form>
    </AuthCard>
  );
}
