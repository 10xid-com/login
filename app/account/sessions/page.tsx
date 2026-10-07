import type { Metadata } from "next";
import { requireOwnAccount } from "@/lib/auth/require";
import { activeSessionsForUser, liveGrantForSession, organizationById } from "@/lib/db/identity";
import { PortalShell } from "../../portal-shell";
import { revokeOthersAction, revokeSessionAction } from "./actions";

export const metadata: Metadata = { title: "Your sessions" };

const DONE: Record<string, string> = {
  one: "That session was signed out.",
  others: "Every other device was signed out.",
};

function ago(date: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * How long this session has left, in words.
 *
 * A session lasts until it is signed out, so its stored expiry is the browser's
 * own 400-day ceiling rather than a policy anybody chose. Printing that date
 * would invite the reading that something expires then — so it says what is
 * actually true, and only names a date for a session that really is running out
 * (one created under the older, shorter policy, which some still are).
 */
function lifetime(expiresAt: Date): string {
  const daysLeft = (expiresAt.getTime() - Date.now()) / 86_400_000;
  if (daysLeft > 365) return "lasts until you sign out";
  return `expires ${expiresAt.toISOString().slice(0, 16).replace("T", " ")}`;
}

/**
 * Every session this person holds, and a way to end any of them.
 *
 * The cheapest incident-response tool there is. A session reaching a laptop
 * left on a train is a phone call away from being useless, without anyone
 * needing database access — and because sessions live server-side, revoking one
 * takes effect on the very next request rather than whenever a token happens to
 * expire.
 */
export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  const ctx = await requireOwnAccount("/account/sessions");
  const params = await searchParams;

  const sessions = await activeSessionsForUser(ctx.userId);
  const grant = ctx.scope.isStaff ? await liveGrantForSession(ctx.sessionId) : null;
  const actingOrg = grant ? await organizationById(grant.organizationId) : null;

  /**
   * One row per DEVICE, not per session. A browser holds a session on each
   * host it has been handed to as well as the login host's, and they are one
   * device: listing them apart would offer "sign out" on half of a browser, and
   * count somebody's own login-host session among their other devices.
   */
  const deviceOf = (s: { id: string; sourceSessionId: string | null }) =>
    s.sourceSessionId ?? s.id;
  const devices = [...Map.groupBy(sessions, deviceOf).values()];
  const thisDevice = deviceOf(
    sessions.find((s) => s.id === ctx.sessionId) ?? {
      id: ctx.sessionId,
      sourceSessionId: null,
    },
  );
  const others = devices.filter((d) => deviceOf(d[0]) !== thisDevice).length;

  return (
    <PortalShell
      email={ctx.email}
      isStaff={ctx.scope.isStaff}
      actingOn={actingOrg && grant ? { name: actingOrg.name, reason: grant.reason } : null}
    >
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Your sessions
          </h1>
          <p className="mt-1 max-w-prose text-sm text-ink-soft">
            Each device you have signed in on is listed with every domain it
            holds a session on, and they last until you sign out. This screen is how you end one you no
            longer want — on a laptop left somewhere, say — and it takes effect
            on that session&rsquo;s very next request.
          </p>
        </div>
        {others > 0 ? (
          <form action={revokeOthersAction}>
            <button
              type="submit"
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm
                         font-medium text-ink-soft transition-colors duration-150
                         hover:bg-sunk focus-visible:outline-2
                         focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              Sign out {others} other {others === 1 ? "device" : "devices"}
            </button>
          </form>
        ) : null}
      </div>

      {params.done ? (
        <p
          role="status"
          className="mb-5 rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good"
        >
          {DONE[params.done] ?? "Done."}
        </p>
      ) : null}

      <ul className="overflow-hidden rounded-xl border border-line bg-surface shadow-card divide-y divide-line-soft">
        {devices.map((device) => {
          const isCurrent = deviceOf(device[0]) === thisDevice;
          // Newest activity first, as the list is ordered.
          const latest = device[0];
          return (
            <li
              key={deviceOf(latest)}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                {device.map((session) => (
                  <p key={session.id} className="truncate font-mono text-sm text-ink">
                    {session.issuedForHost}
                  </p>
                ))}
                <p className="mt-0.5 text-xs text-ink-faint">
                  {latest.roleAtCreation} · last used {ago(latest.lastSeenAt)} ·{" "}
                  {lifetime(latest.absoluteExpiresAt)}
                </p>
              </div>

              {isCurrent ? (
                <span className="flex-none rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand">
                  this device
                </span>
              ) : null}

              <form action={revokeSessionAction} className="flex-none">
                <input type="hidden" name="sessionId" value={latest.id} />
                <button
                  type="submit"
                  className="rounded-md border border-line px-2.5 py-1 text-xs font-medium
                             text-ink-soft transition-colors duration-150 hover:bg-sunk
                             focus-visible:outline-2 focus-visible:outline-offset-2
                             focus-visible:outline-brand"
                >
                  {isCurrent ? "Sign out here" : "Sign out"}
                </button>
              </form>
            </li>
          );
        })}
      </ul>
    </PortalShell>
  );
}
