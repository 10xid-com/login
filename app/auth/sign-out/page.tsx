import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLoginSession, uidHomeForSession } from "@/lib/auth/login";
import { signOutAction, signOutEverywhereAction } from "../identity-actions";
import { AuthCard, SubmitButton } from "../auth-card";
import { SecondaryButton, TextLink } from "../flow-ui";

export const metadata: Metadata = { title: "Sign out" };

/**
 * Where a UiD's Sign out lands: the UiD has already ended its own session,
 * and this ends the sign-in here, which every UiD checks. A page with a
 * button rather than a link that signs out on arrival, so another site can't
 * sign somebody out by sending them here.
 */
export default async function SignOutPage() {
  const session = await getLoginSession();
  if (!session) redirect("/auth/sign-in?notice=signed-out");
  const uidHome = await uidHomeForSession();
  return (
    <AuthCard title="Sign out" intro={`Signed in as ${session.user.email}.`}
      footer={uidHome ? <TextLink href={uidHome}>Stay signed in</TextLink> : <TextLink href="/auth/account">Stay signed in</TextLink>}>
      <form action={signOutAction}>
        <SubmitButton>Sign out</SubmitButton>
      </form>
      <form action={signOutEverywhereAction} className="mt-3">
        <SecondaryButton>Sign out on every device</SecondaryButton>
      </form>
    </AuthCard>
  );
}
