import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { configuredProviders, getAuth } from "@/lib/auth/auth";
import { authenticatorState, getLoginSession } from "@/lib/auth/login";
import {
  linkProviderAction,
  regenerateRecoveryCodesAction,
  resetAuthenticatorAction,
  revokeSessionAction,
  signOutAction,
  signOutEverywhereAction,
} from "../identity-actions";
import { AuthCard, FieldError } from "../auth-card";
import { Hidden, Notice, SecondaryButton, TextLink } from "../flow-ui";

export const metadata: Metadata = { title: "Your sign-in" };

const NOTICES: Record<string, string> = {
  revoked: "That session is signed out.",
  linked: "Linked. You can now sign in that way too — your authenticator is still required.",
};
const ERRORS: Record<string, string> = {
  fresh: "For this, confirm with your authenticator again first: sign out and sign back in.",
  link: "That provider could not be linked. Its address must match this one.",
  failed: "That did not work. Try again.",
};

/** Sessions, authenticator and recovery codes, and signing out — all on the login host. */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string; left?: string }>;
}) {
  const params = await searchParams;
  const session = await getLoginSession();
  if (!session) redirect("/auth/sign-in?next=%2Fauth%2Faccount");
  if (!session.mfaVerifiedAt) redirect("/auth/mfa?next=%2Fauth%2Faccount");

  const h = await headers();
  const [sessions, accounts, factor] = await Promise.all([
    getAuth().api.listSessions({ headers: h }),
    getAuth().api.listUserAccounts({ headers: h }),
    authenticatorState(session.user.id),
  ]);
  const linked = new Set(accounts.map((a) => a.providerId));
  const linkable = configuredProviders().filter((p) => !linked.has(p));
  const notice =
    params.notice === "recovered"
      ? `You used a recovery code (${params.left ?? 0} left). If your authenticator is lost, replace it below now.`
      : params.notice ? NOTICES[params.notice] : null;
  const error = params.error ? ERRORS[params.error] : null;

  return (
    <AuthCard title="Your sign-in" intro={session.user.email}
      footer={<TextLink href="/">Continue to 10XiD</TextLink>}>
      {notice ? <Notice>{notice}</Notice> : null}
      {error ? <FieldError>{error}</FieldError> : null}

      <h2 className="mt-2 text-sm font-semibold text-ink">Signed-in sessions</h2>
      <ul className="mt-2 divide-y divide-line-soft rounded-lg border border-line">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="min-w-0 text-ink-soft">
              <span className="block truncate text-ink">{s.userAgent ?? "Unknown device"}</span>
              Since {new Date(s.createdAt).toLocaleString("en-GB")}
              {s.id === session.sessionId ? " · this device" : ""}
            </span>
            <form action={revokeSessionAction}>
              <Hidden name="session" value={s.id} />
              <button type="submit" className="text-sm font-medium text-bad hover:underline">Sign out</button>
            </form>
          </li>
        ))}
      </ul>
      <form action={signOutEverywhereAction} className="mt-3">
        <SecondaryButton>Sign out on every device</SecondaryButton>
      </form>

      <h2 className="mt-6 text-sm font-semibold text-ink">Authenticator</h2>
      <p className="mt-1 text-sm text-ink-soft">
        {factor.state === "enrolled" ? `Set up. ${factor.recoveryCodesLeft} recovery codes left.` : "Not set up."}
      </p>
      <form action={regenerateRecoveryCodesAction} className="mt-2">
        <SecondaryButton>Make new recovery codes</SecondaryButton>
      </form>
      <form action={resetAuthenticatorAction} className="mt-3">
        <SecondaryButton>Replace authenticator</SecondaryButton>
      </form>

      {linkable.length > 0 ? (
        <>
          <h2 className="mt-6 text-sm font-semibold text-ink">Sign in with</h2>
          {linkable.map((provider) => (
            <form key={provider} action={linkProviderAction} className="mt-2">
              <Hidden name="provider" value={provider} />
              <SecondaryButton>Link {provider === "google" ? "Google" : "Microsoft"}</SecondaryButton>
            </form>
          ))}
        </>
      ) : null}

      <form action={signOutAction} className="mt-6">
        <SecondaryButton>Sign out</SecondaryButton>
      </form>
    </AuthCard>
  );
}
