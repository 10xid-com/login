import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
  INVITE_ROLES,
  clientBusinesses,
  getOperator,
  isFresh,
  openBindings,
} from "@/lib/auth/operator";
import { decideBindingAction, endAccessAction, inviteAction } from "./actions";
import { FieldError, inputClass, labelClass } from "../auth-card";
import { Notice, SecondaryButton, TextLink } from "../flow-ui";

export const metadata: Metadata = { title: "Operator" };

const NOTICES: Record<string, (who?: string) => string> = {
  confirmed: () => "Confirmed. That sign-in now opens the account.",
  rejected: () => "Rejected. The sign-in stays unbound.",
  invited: (who) => `Invited ${who}. They can create their sign-in with that address for seven days.`,
  reset: (who) => `Authenticator removed and every session ended for ${who}. They set up a new one at their next sign-in.`,
  "signed-out": (who) => `Every session ended for ${who}.`,
};

const ERRORS: Record<string, string> = {
  code: "Enter the current code from your authenticator app.",
  locked: "Too many incorrect codes. Try again in 15 minutes.",
  rate: "Too many attempts. Wait a few minutes.",
  invalid: "Something in that form was not valid.",
  invite: "That invitation was refused: check the address, business and role.",
  no_identity: "No sign-in exists for that address.",
  not_found: "That request no longer exists.",
  already_decided: "That request was already decided.",
  account_deleted: "That account has been deleted.",
  already_bound: "That account is already bound to another sign-in.",
  address_not_owned: "That address no longer belongs to the account.",
  identity_taken: "That sign-in is already bound to another account.",
  first_operator: "Until your own account is confirmed, you can only confirm your own sign-in.",
};

/** The authenticator code each action carries, unless one was entered in the last five minutes. */
function Code({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <input name="code" inputMode="numeric" autoComplete="off" pattern="\d{6}" maxLength={6} required
      placeholder="Authenticator code" aria-label="Authenticator code"
      className={`${inputClass} w-40`} />
  );
}

/**
 * Operator screen: answers the requests the sign-in flow cannot answer by
 * itself. Visible only to operators (OPERATOR_EMAILS); anybody else gets the
 * same 404 as a page that does not exist.
 */
export default async function OperatorPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string; who?: string }>;
}) {
  await connection();
  const op = await getOperator();
  if (!op) notFound();
  const params = await searchParams;
  const first = op.bootstrapRequestId;
  const [allRequests, businesses] = await Promise.all([openBindings(), first ? [] : clientBusinesses()]);
  // The first operator sees their own request and nothing else (lib/auth/operator.ts).
  const requests = first ? allRequests.filter((r) => r.id === first) : allRequests;
  const needsCode = !isFresh(op);
  const notice = params.notice ? NOTICES[params.notice]?.(params.who) : null;
  const error = params.error ? (ERRORS[params.error] ?? "That did not work.") : null;

  return (
    <main className="min-h-dvh bg-ground px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-8">
        <header className="flex items-baseline justify-between">
          <div>
            <div className="text-xs font-semibold tracking-[0.06em] text-brand">10XiD</div>
            <h1 className="mt-1 text-xl font-semibold text-ink">Operator</h1>
            <p className="mt-1 text-sm text-ink-soft">
              Signed in as {op.email}.{" "}
              {needsCode
                ? "Each action asks for a code from your authenticator."
                : "Authenticator confirmed in the last five minutes."}
            </p>
          </div>
          <TextLink href="/auth/account">Your sign-in</TextLink>
        </header>

        {first ? (
          <Notice>
            No operator account is confirmed yet, so you can confirm your own sign-in here: it is for{" "}
            {op.email}, which is on the operator list. After that this screen works as usual, and this
            shortcut closes for good.
          </Notice>
        ) : null}
        {notice ? <Notice>{notice}</Notice> : null}
        {error ? <FieldError>{error}</FieldError> : null}

        <section className="rounded-2xl border border-line bg-surface p-6 shadow-card">
          <h2 className="text-sm font-semibold text-ink">Waiting for confirmation</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Somebody signed in with an address that belongs to an account from before. Confirm only after
            checking with the person by another channel — a call to a number already on file — that it was them.
          </p>
          {requests.length === 0 ? (
            <p className="mt-4 text-sm text-ink-faint">No open requests.</p>
          ) : (
            <ul className="mt-4 divide-y divide-line-soft">
              {requests.map((r) => (
                <li key={r.id} className="py-3 text-sm">
                  <div className="text-ink">
                    {r.email}
                    {r.full_name ? ` — ${r.full_name}` : ""}
                  </div>
                  <div className="text-ink-soft">
                    Account {r.account_email} · {r.businesses} · asked {new Date(r.requested_at).toLocaleString("en-GB")}
                  </div>
                  <form action={decideBindingAction} className="mt-2 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="request" value={r.id} />
                    <Code show={needsCode} />
                    <button name="decision" value="confirm" type="submit"
                      className="rounded-lg bg-brand-surface px-3 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover">
                      Confirm
                    </button>
                    {first ? null : (
                      <button name="decision" value="reject" type="submit"
                        className="rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink hover:bg-sunk">
                        Reject
                      </button>
                    )}
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>

        {first ? null : (
          <>
        <section className="rounded-2xl border border-line bg-surface p-6 shadow-card">
          <h2 className="text-sm font-semibold text-ink">Invite somebody</h2>
          <form action={inviteAction} className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="invite-email" className={labelClass}>Email</label>
              <input id="invite-email" name="email" type="email" required className={inputClass} />
            </div>
            <div>
              <label htmlFor="invite-business" className={labelClass}>Business</label>
              <select id="invite-business" name="business" required className={inputClass}>
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="invite-role" className={labelClass}>Role</label>
              <select id="invite-role" name="role" required defaultValue="owner" className={inputClass}>
                {INVITE_ROLES.map((r) => (
                  <option key={r} value={r}>{r.replace("_", " ")}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 sm:col-span-2">
              <Code show={needsCode} />
              <SecondaryButton>Send invitation</SecondaryButton>
            </div>
          </form>
          <p className="mt-2 text-xs text-ink-faint">
            Lasts seven days. What they can do depends on the role. No email is sent
            from here: tell them to create their sign-in at login.10xid.com/auth/sign-up with this exact address.
          </p>
        </section>

        <section className="rounded-2xl border border-line bg-surface p-6 shadow-card">
          <h2 className="text-sm font-semibold text-ink">Lost phone, or a session to end</h2>
          <form action={endAccessAction} className="mt-3 space-y-3">
            <div>
              <label htmlFor="end-email" className={labelClass}>Email they sign in with</label>
              <input id="end-email" name="email" type="email" required className={inputClass} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Code show={needsCode} />
              <button name="what" value="reset" type="submit"
                className="rounded-lg border border-bad/40 px-3 py-2 text-sm font-semibold text-bad hover:bg-bad/5">
                Reset authenticator and sign out everywhere
              </button>
              <button name="what" value="sign-out" type="submit"
                className="rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink hover:bg-sunk">
                Sign out everywhere
              </button>
            </div>
          </form>
          <p className="mt-2 text-xs text-ink-faint">
            Reset only after confirming who is asking by another channel. They set up a new authenticator at their
            next sign-in, which needs an emailed code.
          </p>
        </section>
          </>
        )}
      </div>
    </main>
  );
}
