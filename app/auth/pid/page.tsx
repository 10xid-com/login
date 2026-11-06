import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { configuredProviders, getAuth } from "@/lib/auth/auth";
import { authenticatorState, getLoginSession, mfaRecent, ownSignInSessions, uidHomeForSession } from "@/lib/auth/login";
import { getOperator } from "@/lib/auth/operator";
import { userByAuthUserId, workRolesForAuthUser } from "@/lib/db/accounts";
import { verifiedDiscovery } from "@/lib/db/uid-members";
import { SigninLinksPanel } from "../signin-links-panel";
import { EMAIL_CHANGE_MINUTES, pendingEmailChange } from "@/lib/auth/email-change";
import {
  cancelEmailChangeAction,
  confirmEmailChangeAction,
  requestEmailChangeAction,
  setPasswordAction,
  linkProviderAction,
  regenerateRecoveryCodesAction,
  resetAuthenticatorAction,
  revokeSessionAction,
  signOutAction,
  signOutEverywhereAction,
} from "../identity-actions";
import { AuthCard, FieldError, inputClass, labelClass } from "../auth-card";
import { Hidden, Notice, SecondaryButton, TextLink } from "../flow-ui";

export const metadata: Metadata = { title: "PiD" };

const NOTICES: Record<string, string> = {
  revoked: "That session is signed out.",
  linked: "Linked. You can now sign in that way too — your authenticator is still required.",
  password: "Password saved. Any other sessions have been signed out.",
  "email-sent": `Code sent. Check that mailbox and type the code below within ${EMAIL_CHANGE_MINUTES} minutes.`,
  "email-changed": "Address changed. Sign in with the new one from now on.",
};
const ERRORS: Record<string, string> = {
  fresh: "For this, confirm with your authenticator again first: sign out and sign back in.",
  link: "That provider could not be linked. Its address must match this one.",
  failed: "That did not work. Try again.",
  password: "Choose a password of at least 12 characters.",
  current: "That is not your current password.",
  rate: "Too many attempts. Wait a few minutes and try again.",
  email: "Enter a valid email address.",
  same: "That is already your address.",
  totp: "Enter the current code from your authenticator app.",
  locked: "Too many incorrect codes. Try again in 15 minutes.",
  "email-code": "That code is not right. Use the code emailed to the new address.",
  "email-expired": "That code has expired. Ask for a new one.",
  "email-taken": "That address can't be used. Choose another.",
  "email-unchanged": "That is already your address.",
  "email-no_account": "This sign-in is not tied to an account yet.",
  "email-invalid": "That did not work. Try again.",
};

/**
 * The private PiD shows company roles and sign-in settings in one place.
 */
export default async function PidPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string; left?: string }>;
}) {
  const params = await searchParams;
  const session = await getLoginSession();
  if (!session) redirect("/auth/sign-in?next=%2Fauth%2Fpid");
  if (!session.mfaVerifiedAt) redirect("/auth/mfa?next=%2Fauth%2Fpid");

  const h = await headers();
  const [sessions, accounts, factor, operator, pending, uidHome, workRoles] = await Promise.all([
    ownSignInSessions(session.user.id),
    getAuth().api.listUserAccounts({ headers: h }),
    authenticatorState(session.user.id),
    getOperator(),
    pendingEmailChange(session.user.id),
    uidHomeForSession(),
    workRolesForAuthUser(session.user.id),
  ]);
  const account = await userByAuthUserId(session.user.id);
  const discovery = account ? await verifiedDiscovery(account.id) : [];
  const fresh = mfaRecent(session);
  const linked = new Set(accounts.map((a) => a.providerId));
  const hasPassword = linked.has("credential");
  const linkable = configuredProviders().filter((p) => !linked.has(p));
  const notice =
    params.notice === "recovered"
      ? `You used a recovery code (${params.left ?? 0} left). If your authenticator is lost, replace it below now.`
      : params.notice === "password"
        ? `Password saved for ${session.user.email}. Any other sessions have been signed out.`
        : params.notice ? NOTICES[params.notice] : null;
  const error = params.error ? ERRORS[params.error] : null;

  return (
    <AuthCard title="PiD" intro={session.user.name.trim() || session.user.email}
      footer={
        <>
          {uidHome ? <><TextLink href={uidHome}>Back to your UiD</TextLink> · </> : null}
          <TextLink href="/">Continue to 10XiD</TextLink>
          {operator ? <> · <TextLink href="/auth/operator">Operator</TextLink></> : null}
        </>
      }>
      {notice ? <Notice>{notice}</Notice> : null}
      {error ? <FieldError>{error}</FieldError> : null}

      <nav aria-label="PiD sections" className="mt-3 flex gap-4 text-sm">
        <TextLink href="#work">Work</TextLink>
        <TextLink href="/auth/pid/my-work">My Work</TextLink>
        <TextLink href="#settings">Settings</TextLink>
      </nav>

      <details id="work" className="mt-4 rounded-lg border border-line" open>
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-ink">Work</summary>
        {workRoles.length > 0 ? (
          <ul aria-label="Company roles" className="divide-y divide-line-soft border-t border-line">
            {workRoles.map((assignment) => (
              <li key={assignment.organizationId} className="flex flex-wrap justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="break-words font-medium text-ink">{assignment.organizationName}</span>
                <span className="capitalize text-ink-soft">{assignment.role.replaceAll("_", " ")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="border-t border-line px-3 py-2 text-sm text-ink-soft">Your company roles will appear here when they’re assigned.</p>
        )}
        <p className="border-t border-line px-3 py-2 text-sm"><TextLink href="/auth/pid/my-work">Open My Work</TextLink></p>
      </details>

      <section id="settings" aria-labelledby="pid-settings" className="mt-6">
        <h2 id="pid-settings" className="text-base font-semibold text-ink">Settings</h2>
        {operator ? (
          <>
            <h3 className="mt-2 text-sm font-semibold text-ink">Operator</h3>
            <p className="mt-1 text-sm text-ink-soft">
              Invite people, confirm sign-ins that are waiting, and help with a lost phone.
            </p>
            <a href="/auth/operator"
              className="mt-2 block rounded-lg bg-brand-surface px-4 py-2.5 text-center text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover">
              Open operator tools
            </a>
          </>
        ) : null}

        <h3 className="mt-6 text-sm font-semibold text-ink">Email address</h3>
        {pending ? (
          <>
            <p className="mt-1 text-sm text-ink-soft">
              A code was sent to <span className="text-ink">{pending}</span>. Type it here to make that your address.
            </p>
            <form action={confirmEmailChangeAction} className="mt-2">
              <label htmlFor="email-code" className={labelClass}>Code from the email</label>
              <input id="email-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}"
                maxLength={6} required className={inputClass} />
              <SecondaryButton>Change address</SecondaryButton>
            </form>
            <form action={cancelEmailChangeAction} className="mt-2">
              <button type="submit" className="text-sm font-medium text-ink-soft hover:underline">Cancel</button>
            </form>
          </>
        ) : (
          <form action={requestEmailChangeAction} className="mt-2">
            <p className="text-sm text-ink-soft">
              You sign in as {session.user.email}. To change it, enter the new address and we will email it a code.
            </p>
            <label htmlFor="new-email" className={`${labelClass} mt-3`}>New address</label>
            <input id="new-email" name="email" type="email" autoComplete="email" required className={inputClass} />
            {fresh ? null : (
              <>
                <label htmlFor="email-totp" className={`${labelClass} mt-3`}>Code from your authenticator app</label>
                <input id="email-totp" name="code" inputMode="numeric" autoComplete="off" pattern="\d{6}" maxLength={6}
                  required className={inputClass} />
              </>
            )}
            <SecondaryButton>Send code</SecondaryButton>
          </form>
        )}

        <h3 className="mt-6 text-sm font-semibold text-ink">Signed-in sessions</h3>
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

        <h3 className="mt-6 text-sm font-semibold text-ink">Authenticator</h3>
        <p className="mt-1 text-sm text-ink-soft">
          {factor.state === "enrolled" ? `Set up. ${factor.recoveryCodesLeft} recovery codes left.` : "Not set up."}
        </p>
        <form action={regenerateRecoveryCodesAction} className="mt-2">
          <SecondaryButton>Make new recovery codes</SecondaryButton>
        </form>
        <form action={resetAuthenticatorAction} className="mt-3">
          <SecondaryButton>Replace authenticator</SecondaryButton>
        </form>

        <h3 className="mt-6 text-sm font-semibold text-ink">Password</h3>
        <p className="mt-1 text-sm text-ink-soft">
          For signing in as <span className="font-medium text-ink">{session.user.email}</span>, on every UiD that
          address opens. Another person&apos;s password is set by signing in as them.
        </p>
        <form action={setPasswordAction} className="mt-2">
          {/* Tells a password manager which address this password belongs to. */}
          <input type="text" name="username" autoComplete="username" value={session.user.email} readOnly hidden />
          {hasPassword ? (
            <>
              <label htmlFor="current" className={labelClass}>Current password</label>
              <input id="current" name="current" type="password" autoComplete="current-password" required className={inputClass} />
            </>
          ) : (
            <p className="text-sm text-ink-soft">No password yet. You sign in with an emailed code, or add one here.</p>
          )}
          <label htmlFor="password" className={`${labelClass} mt-3`}>{hasPassword ? "New password" : "Password"}</label>
          <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128}
            required className={inputClass} />
          <SecondaryButton>{hasPassword ? "Change password" : "Add password"}</SecondaryButton>
        </form>

        {linkable.length > 0 ? (
          <>
            <h3 className="mt-6 text-sm font-semibold text-ink">Sign in with</h3>
            {linkable.map((provider) => (
              <form key={provider} action={linkProviderAction} className="mt-2">
                <Hidden name="provider" value={provider} />
                <SecondaryButton>Link {provider === "google" ? "Google" : "Microsoft"}</SecondaryButton>
              </form>
            ))}
          </>
        ) : null}

        {account ? <SigninLinksPanel links={discovery.map(({ link, memberships }) => ({ linkId: link.linkId, email: link.email, name: link.name, primary: link.primary, verifiedAt: link.verifiedAt, memberships }))} /> : null}

        <form action={signOutAction} className="mt-6">
          <SecondaryButton>Sign out</SecondaryButton>
        </form>
      </section>
    </AuthCard>
  );
}
