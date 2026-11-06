"use client";

import { useState, type ReactNode } from "react";
import { completeSigninLinkAction, revokeSigninLinkAction, startSigninLinkAction, type LinkActionResult } from "./signin-link-actions";
import { inputClass, labelClass } from "./auth-card";

export type PanelLink = {
  linkId: string; email: string; name: string; primary: boolean; verifiedAt: string;
  memberships: { id: string; name: string; roleLabel: string }[];
};

export const LINK_REASONS: Record<string, string> = {
  sign_in: "Sign in again, then retry.",
  rate: "Too many attempts. Wait a few minutes and try again.",
  totp: "Enter the current 6-digit code from your authenticator app. A code works once, so wait for the next one if you just used it.",
  locked: "Too many incorrect authenticator codes. Try again in 15 minutes.",
  no_session: "This sign-in has ended. Sign in again, then retry.",
  not_fresh: "Confirm with your authenticator again, then retry. If you just signed in, wait for your authenticator to show its next code (about 30 seconds), because a code works only once.",
  recipient: "Enter the verified email address of the other account.",
  unsettled: "One of the two accounts has a sign-in change waiting for an operator. Finish that first.",
  limit: "An account can have at most 5 verified links. End one first.",
  same_account: "That code came from this same account. Use the other account, in its own browser profile.",
  exists: "These two accounts are already linked.",
  invalid: "That code did not work. It may be wrong, already used, expired (4 minutes), meant for a different account, or its starting session ended. Check the other account's verified email, then ask for a new one.",
  not_found: "That link no longer exists.",
};
export const failureText = (reason: string) => LINK_REASONS[reason] ?? LINK_REASONS.invalid;

function Totp({ id }: { id: string }) {
  return (
    <>
      <label htmlFor={id} className={`${labelClass} mt-3`}>Code from your authenticator app</label>
      <input id={id} name="totp" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" maxLength={6} required className={inputClass} />
    </>
  );
}

function Submit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button type="submit" disabled={busy}
      className="mt-3 w-full rounded-lg border border-line px-4 py-2.5 text-sm font-semibold text-ink hover:bg-sunk disabled:opacity-60">
      {children}
    </button>
  );
}

type Message = { tone: "ok" | "bad"; text: string };

export function SigninLinksPanel({ links }: { links: PanelLink[] }) {
  const [code, setCode] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);

  /** The one-time code lives only in this component's memory: never a URL, storage, or log. */
  const handle = (action: (form: FormData) => Promise<LinkActionResult>, okText: string) => async (data: FormData) => {
    setBusy(true);
    setCode(null);
    try {
      const result = await action(data);
      if (result.ok) {
        setMessage({ tone: "ok", text: okText });
        if (result.code) setCode(result.code);
      } else {
        setMessage({ tone: "bad", text: failureText(result.reason) });
      }
    } catch {
      setMessage({ tone: "bad", text: "Something went wrong. Reload the page and try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="linked-accounts" aria-labelledby="linked-accounts-title" className="mt-6">
      <h2 id="linked-accounts-title" className="text-base font-semibold text-ink">Linked sign-ins</h2>
      <p className="mt-1 text-sm text-ink-soft">
        If you have two 10XiD accounts, you can link them so each one can <em>see</em> the other&apos;s businesses.
        A link is for discovery only: it never gives either account a role, permission or access it did not already have.
      </p>
      <details className="mt-2 rounded-lg border border-line px-3 py-2 text-sm text-ink-soft">
        <summary className="cursor-pointer font-medium text-ink">How this stays safe</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>You must be able to sign in to <strong>both</strong> accounts, each with its own authenticator, at the same time.</li>
          <li>Use two separate browser profiles. Signing in as the second account in this browser would end this session.</li>
          <li>Each step asks for a fresh authenticator code from the account you are using. If you only just signed in, wait for your authenticator&apos;s next code (about 30 seconds): the sign-in code cannot be reused.</li>
          <li>The code only works for the account that owns the verified email address you enter. Another account holding the code cannot use it.</li>
          <li>The link code is shown once, works once, expires in 4 minutes, works only for the other account&apos;s verified email address you enter, and stops working if the account that created it signs out. Never send it by email, chat or text; type it yourself.</li>
          <li>Anyone who controls both accounts&apos; authenticators can link them. Anyone who controls either can end the link.</li>
          <li>Ending a link does not bring back any older automatic pairing.</li>
        </ul>
      </details>

      {message ? (
        <p role={message.tone === "bad" ? "alert" : "status"}
          className={`mt-3 rounded-lg border border-line px-3 py-2 text-sm ${message.tone === "bad" ? "text-bad" : "text-ink-soft"}`}>
          {message.text}
        </p>
      ) : null}

      <h3 className="mt-4 text-sm font-semibold text-ink">Active links</h3>
      {links.length === 0 ? <p className="mt-1 text-sm text-ink-soft">No verified links yet.</p> : (
        <ul className="mt-2 divide-y divide-line-soft rounded-lg border border-line">
          {links.map((link) => (
            <li key={link.linkId} className="px-3 py-2 text-sm">
              <p className="break-words font-medium text-ink">{link.name !== link.email ? `${link.name} · ` : ""}{link.email}</p>
              <p className="text-ink-soft">
                {link.primary ? "Main sign-in · " : ""}Verified {new Date(link.verifiedAt).toLocaleDateString("en-GB")}
              </p>
              <p className="mt-1 text-ink-soft">
                {link.memberships.length === 0
                  ? "No businesses on that account."
                  : `Businesses on that account (view only from here): ${link.memberships.map((m) => `${m.name} (${m.roleLabel})`).join(", ")}`}
              </p>
              <p className="mt-1 text-ink-soft">
                To work as that account, sign in as {link.email} in its own browser profile. This page never signs you in as them.
              </p>
              <form action={handle(revokeSigninLinkAction, "Link ended. Neither account sees the other's businesses any more.")} className="mt-2">
                <input type="hidden" name="link" value={link.linkId} />
                <Totp id={`revoke-${link.linkId}`} />
                <Submit busy={busy}>End this link</Submit>
              </form>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-6 text-sm font-semibold text-ink">Add a link</h3>
      <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-ink-soft">
        <li>Open this page in <strong>two browser profiles</strong>, signed in as account A and account B.</li>
        <li>In A, enter the <strong>verified email address of account B</strong> and an authenticator code, then press <em>Get a link code</em>.</li>
        <li>In B, enter that link code and a fresh authenticator code under <em>Use a link code</em>.</li>
        <li>Both accounts now list the link. Either one can end it.</li>
      </ol>

      <form action={handle(startSigninLinkAction, "Your link code is below. It works once, for 4 minutes, and only from the account that owns the email you entered.")} className="mt-3">
        <label htmlFor="link-primary" className={labelClass}>Which sign-in is your main one?</label>
        <select id="link-primary" name="primary" defaultValue="this" className={inputClass}>
          <option value="this">This account</option>
          <option value="other">The other account</option>
        </select>
        <label htmlFor="link-recipient" className={`${labelClass} mt-3`}>Verified email address of the other account</label>
        <input id="link-recipient" name="recipient" type="email" autoComplete="off" maxLength={320} required className={inputClass} />
        <Totp id="link-start-totp" />
        <Submit busy={busy}>Get a link code</Submit>
      </form>
      {code ? (
        <div className="mt-3 rounded-lg border border-line bg-sunk px-3 py-3 text-center" aria-live="polite">
          <p className="text-xs text-ink-soft">Type this into the other account yourself. Do not paste it anywhere else.</p>
          <output className="mt-1 block select-all font-mono text-2xl font-semibold tracking-widest text-ink">{code}</output>
          <button type="button" onClick={() => setCode(null)} className="mt-2 text-sm font-medium text-ink-soft hover:underline">
            Hide code
          </button>
        </div>
      ) : null}

      <form action={handle(completeSigninLinkAction, "Linked. Both accounts can now see each other's businesses.")} className="mt-6">
        <h3 className="text-sm font-semibold text-ink">Use a link code</h3>
        <p className="mt-1 text-sm text-ink-soft">Do this while signed in as the <em>other</em> account, in its own browser profile.</p>
        <label htmlFor="link-code" className={`${labelClass} mt-2`}>Link code</label>
        <input id="link-code" name="code" type="password" autoComplete="off" autoCapitalize="characters" spellCheck={false}
          maxLength={16} required className={inputClass} />
        <Totp id="link-complete-totp" />
        <Submit busy={busy}>Link these accounts</Submit>
      </form>
    </section>
  );
}
