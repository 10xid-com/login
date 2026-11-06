import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AuthCard } from "../../../auth-card";
import { TextLink } from "../../../flow-ui";
import { loadCardContent, loadMyDeck, shapeCardContent, type CardView } from "@/lib/pid/my-work";
import { MY_WORK_PATH, STAGES, UUID, deckPath, parseStageParam, stageIndex } from "@/lib/pid/my-work-paths";
import { myWorkActor } from "@/lib/pid/my-work-session";

export const metadata: Metadata = { title: "Work Deck", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function MyWorkDeckPage({
  params,
  searchParams,
}: {
  params: Promise<{ deck: string }>;
  searchParams: Promise<{ stage?: string | string[] }>;
}) {
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
  // Only the chosen stage (default: the deck's current one) is fetched, on demand.
  const current = stageIndex(deck.stage);
  const asked = parseStageParam((await searchParams).stage);
  const selected = asked >= 0 ? asked : Math.max(current, 0);
  const inline = deck.cards.find((card) => card.title.trim().toLowerCase() === STAGES[selected].toLowerCase());
  const cardId = inline?.id ?? String(selected + 1);
  let content: CardView | "unavailable" | "none";
  const loaded = await loadCardContent(actor.actorId, deckId, cardId);
  if (loaded.ok) {
    const view = shapeCardContent(loaded.value);
    content = { notes: view.notes, files: view.files.length ? view.files : (inline?.files ?? []) };
  } else content = loaded.reason === "unavailable" ? "unavailable" : "none";
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
        <section className="mt-6" aria-label="Stage notes and files">
          <h2 className="text-sm font-semibold text-ink">Stage</h2>
          <nav aria-label="Stages" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {STAGES.map((label, i) => (
              <Link key={label} href={`${deckPath(deck.id)}?stage=${i + 1}`} scroll={false}
                aria-current={i === selected ? "page" : undefined}
                className={i === selected ? "font-semibold text-ink underline" : "text-ink-soft hover:underline"}>
                {label}
              </Link>
            ))}
          </nav>
          <div className="mt-3 rounded-xl border border-line bg-surface p-4 text-sm text-ink">
            <p className="font-medium">{STAGES[selected]}</p>
            {content === "unavailable" ? (
              <p role="alert" className="mt-1 text-ink-soft">This stage could not be loaded. Reload in a minute.</p>
            ) : content === "none" ? (
              <p className="mt-1 text-ink-soft">Nothing is shared for this stage.</p>
            ) : (
              <>
                {content.notes.map((note, i) => <p key={i} className="mt-2 whitespace-pre-wrap break-words">{note}</p>)}
                {content.files.map((file) => (
                  <p key={file.id} className="mt-2 space-x-3">
                    <span className="text-ink-soft">{file.name}</span>
                    <a className="underline" href={`/api/pid/my-work/${deck.id}/cards/${cardId}/content/files/${file.id}?preview=1`} target="_blank" rel="noopener">Preview</a>
                    <a className="underline" href={`/api/pid/my-work/${deck.id}/cards/${cardId}/content/files/${file.id}`}>Download</a>
                  </p>
                ))}
                {content.notes.length === 0 && content.files.length === 0 && <p className="mt-1 text-ink-soft">No notes or files for this stage.</p>}
              </>
            )}
          </div>
        </section>
        {deck.history.length > 0 && (
          <section className="mt-6" aria-label="Handoff history">
            <h2 className="text-sm font-semibold text-ink">Handoff history</h2>
            <ul className="mt-2 divide-y divide-line rounded-2xl border border-line bg-surface">
              {deck.history.map((event, i) => (
                <li key={i} className="p-3 text-sm text-ink">
                  {event.at && <span className="block text-xs text-ink-soft">{event.at}</span>}
                  {event.text}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
