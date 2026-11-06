import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AuthCard } from "../../../auth-card";
import { TextLink } from "../../../flow-ui";
import { loadMyDeck } from "@/lib/pid/my-work";
import { MY_WORK_PATH, UUID, deckPath } from "@/lib/pid/my-work-paths";
import { myWorkActor } from "@/lib/pid/my-work-session";

export const metadata: Metadata = { title: "Work Deck", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function MyWorkDeckPage({ params }: { params: Promise<{ deck: string }> }) {
  const { deck: raw } = await params;
  const deckId = raw.toLowerCase();
  if (!UUID.test(deckId)) notFound();
  const next = encodeURIComponent(deckPath(deckId));
  const actor = await myWorkActor();
  if (actor.state === "signed_out") redirect(`/auth/sign-in?next=${next}`);
  if (actor.state === "needs_mfa") redirect(`/auth/mfa?next=${next}`);
  if (actor.state === "no_account") notFound();

  const result = await loadMyDeck(actor.actorId, deckId);
  // Not yours and does not exist are the same answer; neither is shown as an empty deck.
  if (!result.ok && result.reason !== "unavailable") notFound();
  if (!result.ok) {
    return (
      <AuthCard title="Work Deck" footer={<TextLink href={MY_WORK_PATH}>Back to My Work</TextLink>}>
        <div role="alert" className="text-sm text-ink">
          <p className="font-medium">This deck could not be loaded.</p>
          <p className="mt-1 text-ink-soft">This is a temporary problem. Reload in a minute.</p>
        </div>
      </AuthCard>
    );
  }
  const deck = result.value;
  const rows: [string, string][] = [
    ["Stage", deck.stage],
    ["Status", deck.status],
    ["Next step", deck.nextAction || deck.action],
    ["Due", deck.due],
    ["Owner", deck.owner],
    ["Participants", deck.participants.join(", ")],
  ];
  return (
    <main className="min-h-dvh bg-ground px-4 py-12">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-6"><TextLink href={MY_WORK_PATH}>← My Work</TextLink></div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{deck.title}</h1>
        <dl className="mt-6 divide-y divide-line rounded-2xl border border-line bg-surface">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-3 gap-3 p-4 text-sm">
              <dt className="text-ink-soft">{label}</dt>
              <dd className="col-span-2 text-ink">{value || "—"}</dd>
            </div>
          ))}
        </dl>
        {deck.cards.length > 0 && (
          <section className="mt-6" aria-label="Cards">
            <h2 className="text-sm font-semibold text-ink">Cards</h2>
            <ul className="mt-2 space-y-2">
              {deck.cards.map((card) => (
                <li key={card.id} className="rounded-xl border border-line bg-surface p-4 text-sm text-ink">
                  <p className="font-medium">{card.title}</p>
                  {card.files.map((file) => (
                    <p key={file.id} className="mt-1 space-x-3">
                      <span className="text-ink-soft">{file.name}</span>
                      <a className="underline" href={`/api/pid/my-work/${deck.id}/cards/${card.id}/content/files/${file.id}?preview=1`} target="_blank" rel="noopener">Preview</a>
                      <a className="underline" href={`/api/pid/my-work/${deck.id}/cards/${card.id}/content/files/${file.id}`}>Download</a>
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
