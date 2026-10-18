import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLoginSession, nextQuery, safeNext } from "@/lib/auth/login";
import { signOutAction } from "../../identity-actions";
import { AuthCard, SubmitButton } from "../../auth-card";
import { Hidden } from "../../flow-ui";

export const metadata: Metadata = { title: "Switch account" };

/**
 * Signed in, but as an address that may not open this UiD
 * (app/auth/uid/authorize). Never a dead end: one button signs out and returns
 * to the sign-in form with the UiD handoff kept as `next`, so signing in as the
 * right address lands the person on the UiD they asked for.
 *
 * Which addresses DO have access is not shown — that list is not the signed-in
 * person's to read.
 */
export default async function UidDeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const session = await getLoginSession();
  if (!session) redirect(`/auth/sign-in${nextQuery(next)}`);

  const site = siteName(next);

  return (
    <AuthCard
      title="Switch account"
      intro={`You are signed in as ${session.user.email}, which doesn't have access to ${site}. Sign out and sign in with the address that does — you'll come straight back here.`}
    >
      <form action={signOutAction}>
        <Hidden name="next" value={next} />
        <SubmitButton>Sign out and switch account</SubmitButton>
      </form>
    </AuthCard>
  );
}

/** "uid-bypaolo.10xid.com" → "the bypaolo UiD page", in plain words. */
function siteName(next: string): string {
  const host = new URLSearchParams(next.split("?")[1] ?? "").get("host") ?? "";
  const label = host.replace(/\.10xid\.com$/i, "").replace(/^uid-/i, "");
  return label ? `the ${label} UiD page` : "this page";
}
