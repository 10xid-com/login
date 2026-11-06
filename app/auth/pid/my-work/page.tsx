import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "../../auth-card";
import { TextLink } from "../../flow-ui";
import { loadMyWork } from "@/lib/pid/my-work";
import { MY_WORK_PATH, deckPath } from "@/lib/pid/my-work-paths";
import { myWorkActor } from "@/lib/pid/my-work-session";

export const metadata: Metadata = { title: "My Work", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const NEXT = encodeURIComponent(MY_WORK_PATH);

export default async function MyWorkPage() {
  const actor = await myWorkActor();
  if (actor.state === "signed_out") redirect(`/auth/sign-in?next=${NEXT}`);
  if (actor.state === "needs_mfa") redirect(`/auth/mfa?next=${NEXT}`);
  if (actor.state === "no_account") {
    return (
      <AuthCard title="My Work" intro="This sign-in is not tied to a 10XiD account yet, so there is no work to show." footer={<TextLink href="/auth/pid">Back to PiD</TextLink>}>
        <p className="text-sm text-ink-soft">Nothing is missing from your list — it just cannot be looked up for this sign-in.</p>
      </AuthCard>
    );
  }

  const result = await loadMyWork(actor.actorId);
  return (
    <main className="min-h-dvh bg-ground px-4 py-12">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="text-xl font-semibold tracking-tight text-ink">My Work</h1>
          <TextLink href="/auth/pid">PiD</TextLink>
        </div>
        {!result.ok ? (
          <div role="alert" className="rounded-2xl border border-line bg-surface p-6 text-sm text-ink">
            <p className="font-medium">Your work could not be loaded.</p>
            <p className="mt-1 text-ink-soft">This is a temporary problem, not an empty list. Reload in a minute.</p>
          </div>
        ) : result.value.decks.length === 0 ? (
          <div className="rounded-2xl border border-line bg-surface p-6 text-sm text-ink-soft">
            <p className="font-medium text-ink">No Work Decks yet.</p>
            <p className="mt-1">When a deck is shared with you it will appear here.</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {result.value.decks.map((deck) => (
              <li key={deck.id} className="rounded-2xl border border-line bg-surface p-5">
                <Link href={deckPath(deck.id)} className="text-base font-semibold text-ink underline-offset-2 hover:underline">
                  {deck.title}
                </Link>
                <p className="mt-1 text-xs text-ink-soft">{[deck.stage, deck.status].filter(Boolean).join(" · ")}</p>
                <p className="mt-3 text-sm text-ink"><span className="text-ink-soft">Next step: </span>{deck.nextAction || deck.action || "None set"}</p>
                <p className="mt-1 text-sm text-ink"><span className="text-ink-soft">Due: </span>{deck.due || "No due date"}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
