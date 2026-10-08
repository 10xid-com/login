import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { accountStatus, getLoginSession, nextQuery, safeNext } from "@/lib/auth/login";
import { getOperator } from "@/lib/auth/operator";
import { checkAccessAction, signOutAction } from "../identity-actions";
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
    // Not reachable through these pages (every identity is created from a
    // proven mailbox); shown for an identity a provider did not vouch for.
    return (
      <AuthCard title="Confirm your email"
        intro={`${session.user.email} has not been confirmed. Sign out, then sign in with an emailed code.`}>
        <form action={signOutAction}>
          <SubmitButton>Sign out</SubmitButton>
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

  // The first operator confirms their own sign-in (lib/auth/operator.ts).
  const firstOperator = status === "pending_binding" && (await getOperator())?.bootstrapRequestId;

  return (
    <AuthCard title={copy.title} intro={copy.intro}>
      {firstOperator ? (
        <a href="/auth/operator"
          className="mb-3 block rounded-lg bg-brand-surface px-4 py-2.5 text-center text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover">
          You are the operator: confirm this sign-in
        </a>
      ) : null}
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
