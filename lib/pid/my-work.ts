import "server-only";
import { CARD_TOKEN, UUID } from "./my-work-paths";

/**
 * The server-only bridge from Login to the Control Room's personal Work Deck API.
 *
 * Authority: the caller passes the portal account UUID read from the live, MFA-verified sign-in
 * (`userByAuthUserId`). Nothing from a browser (header, query, body) selects the person. The Control
 * Room decides which decks that one person may see; "not yours" and "does not exist" look the same.
 *
 * Network: only the configured trusted origin, only paths built here from validated UUID/token
 * pieces, never a caller-supplied URL, never redirects. This is not a proxy.
 */

const DEFAULT_HOST = "uid-bypaolo.10xid.com";
const TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 1_000_000;
const MAX_FILE_BYTES = 50_000_000;
const SECRET = /^[a-f0-9]{64}$/;

export type WorkDeckSummary = {
  id: string;
  title: string;
  stage: string;
  status: string;
  due: string;
  action: string;
  nextAction: string;
  owner: string;
  participants: string[];
  cards: { id: string; title: string; files: { id: string; name: string }[] }[];
};
export type MyWorkList = { businesses: { id: string; name: string }[]; decks: WorkDeckSummary[] };

export type BridgeFailure = "unavailable" | "not_found" | "forbidden";
export type BridgeResult<T> = { ok: true; value: T } | { ok: false; reason: BridgeFailure };

/** The configured Control Room origin, or null when it is not a plain trusted https 10xid.com origin. */
export function trustedOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.CONTROL_ROOM_ORIGIN?.trim() || `https://${env.CLOTHING_UI_HOST?.trim() || DEFAULT_HOST}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  if (!url.hostname.endsWith(".10xid.com")) return null;
  return url.origin;
}

function config(): { origin: string; secret: string } | null {
  const origin = trustedOrigin();
  const secret = process.env.CID_WORK_DECKS_SECRET;
  return origin && secret && SECRET.test(secret) ? { origin, secret } : null;
}

async function call(actorId: string, path: string, accept: "json" | "file"): Promise<BridgeResult<Response>> {
  const cfg = config();
  if (!cfg || !UUID.test(actorId)) return { ok: false, reason: "unavailable" };
  try {
    const response = await fetch(new URL(path, cfg.origin), {
      method: "GET",
      headers: { authorization: `Bearer ${cfg.secret}`, "x-10xid-account": actorId },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 403) return { ok: false, reason: "forbidden" };
    if (response.status === 404) return { ok: false, reason: "not_found" };
    if (!response.ok) return { ok: false, reason: "unavailable" };
    const type = response.headers.get("content-type") ?? "";
    if (accept === "json" && !/^application\/json(?:;|$)/i.test(type)) return { ok: false, reason: "unavailable" };
    return { ok: true, value: response };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_JSON_BYTES) throw new Error("too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(part.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/* ---------------------------- shaping ---------------------------- */

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function text(value: unknown, max = 400): string {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** A person is shown by name only. Email, phone and any other field of a person record are dropped. */
function personName(value: unknown): string {
  const direct = text(value, 120);
  if (direct) return /@/.test(direct) ? "" : direct; // a bare address is contact info, not a name
  const object = asObject(value);
  if (!object) return "";
  const name = text(object.name ?? object.displayName ?? object.fullName, 120);
  return /@/.test(name) ? "" : name;
}

function shapeCards(value: unknown): WorkDeckSummary["cards"] {
  if (!Array.isArray(value)) return [];
  const out: WorkDeckSummary["cards"] = [];
  for (const entry of value.slice(0, 200)) {
    const card = asObject(entry);
    const id = text(card?.id, 64);
    if (!card || !CARD_TOKEN.test(id)) continue;
    const files = Array.isArray(card.files)
      ? card.files.flatMap((file) => {
          const f = asObject(file);
          const fid = text(f?.id, 40).toLowerCase();
          return f && UUID.test(fid) ? [{ id: fid, name: text(f.name, 160) || "File" }] : [];
        })
      : [];
    out.push({ id, title: text(card.title, 200) || "Card", files: files.slice(0, 50) });
  }
  return out;
}

/** Whitelist the Work Deck fields the personal portal shows. Everything else is discarded. */
export function shapeDeck(raw: unknown, fallbackId?: string): WorkDeckSummary | null {
  const deck = asObject(raw);
  if (!deck) return null;
  const id = (text(deck.id, 40) || fallbackId || "").toLowerCase();
  if (!UUID.test(id)) return null;
  const participants = Array.isArray(deck.participants) ? deck.participants.map(personName).filter(Boolean) : [];
  return {
    id,
    title: text(deck.title, 200) || "Untitled Work Deck",
    stage: text(deck.stage, 80),
    status: text(deck.status, 80),
    due: text(deck.due, 40),
    action: text(deck.action, 400),
    nextAction: text(deck.nextAction, 400),
    owner: personName(deck.owner),
    participants: participants.slice(0, 50),
    cards: shapeCards(deck.cards),
  };
}

/* ---------------------------- operations ---------------------------- */

/** The signed-in person's own Work Decks. `actorId` must be the portal account UUID of the session. */
export async function loadMyWork(actorId: string): Promise<BridgeResult<MyWorkList>> {
  const result = await call(actorId, "/internal/pid-my-work", "json");
  if (!result.ok) return result;
  try {
    const body = asObject(await boundedJson(result.value));
    // The Control Room echoes the person it answered for; anything else is a mix-up, never shown.
    if (!body || text(body.userId, 40).toLowerCase() !== actorId) return { ok: false, reason: "unavailable" };
    const businesses = (Array.isArray(body.businesses) ? body.businesses : []).flatMap((entry) => {
      const b = asObject(entry);
      const id = text(b?.id, 64);
      return b && id ? [{ id, name: text(b.name, 160) || "Business" }] : [];
    });
    const source = body.decks;
    const keyed = new Map<string, unknown>();
    if (Array.isArray(source)) for (const item of source) keyed.set(text(asObject(item)?.id, 40).toLowerCase(), item);
    else if (asObject(source)) for (const [key, item] of Object.entries(source as object)) keyed.set(key.toLowerCase(), item);
    const order = Array.isArray(body.order) ? body.order.map((id) => text(id, 40).toLowerCase()) : [];
    const ids = [...new Set([...order.filter((id) => keyed.has(id)), ...keyed.keys()])];
    const decks = ids.flatMap((id) => {
      const deck = shapeDeck(keyed.get(id), id);
      return deck ? [deck] : [];
    });
    return { ok: true, value: { businesses: businesses.slice(0, 100), decks } };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** One deck, only if the Control Room says this person may open it. */
export async function loadMyDeck(actorId: string, deckId: string): Promise<BridgeResult<WorkDeckSummary>> {
  if (!UUID.test(deckId)) return { ok: false, reason: "not_found" };
  const result = await call(actorId, `/internal/pid-my-work/${deckId}`, "json");
  if (!result.ok) return result;
  try {
    const body = asObject(await boundedJson(result.value));
    const deck = shapeDeck(body?.deck, deckId);
    // The deck must be the one asked for.
    return deck && deck.id === deckId ? { ok: true, value: deck } : { ok: false, reason: "unavailable" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)(;|$)/i;
const SAFE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
  "cross-origin-resource-policy": "same-origin",
};

export function safeJsonHeaders(): Record<string, string> {
  return { "cache-control": "private, no-store", "x-content-type-options": "nosniff", vary: "Cookie" };
}

/** Card content (JSON). Pieces are validated again here; the path is built, never forwarded. */
export async function loadCardContent(actorId: string, deck: string, card: string): Promise<BridgeResult<unknown>> {
  if (!UUID.test(deck) || !CARD_TOKEN.test(card)) return { ok: false, reason: "not_found" };
  const result = await call(actorId, `/internal/pid-my-work/${deck}/cards/${card}/content`, "json");
  if (!result.ok) return result;
  try {
    return { ok: true, value: await boundedJson(result.value) };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** A card file for preview (`?preview=1`, safe types only) or download (always an attachment). */
export async function loadCardFile(
  actorId: string,
  deck: string,
  card: string,
  file: string,
  preview: boolean,
): Promise<BridgeResult<Response>> {
  if (!UUID.test(deck) || !CARD_TOKEN.test(card) || !UUID.test(file)) return { ok: false, reason: "not_found" };
  const path = `/internal/pid-my-work/${deck}/cards/${card}/content/files/${file}${preview ? "?preview=1" : ""}`;
  const result = await call(actorId, path, "file");
  if (!result.ok) return result;
  const upstream = result.value;
  if (Number(upstream.headers.get("content-length")) > MAX_FILE_BYTES) {
    await upstream.body?.cancel();
    return { ok: false, reason: "unavailable" };
  }
  const type = upstream.headers.get("content-type") ?? "application/octet-stream";
  const inline = preview && INLINE_TYPES.test(type);
  const headers = new Headers(SAFE_HEADERS);
  headers.set("content-type", inline ? type : "application/octet-stream");
  headers.set("content-disposition", inline ? "inline" : 'attachment; filename="download"');
  return { ok: true, value: new Response(upstream.body, { status: 200, headers }) };
}

export function failureStatus(reason: BridgeFailure): number {
  return reason === "unavailable" ? 503 : 404; // "forbidden" is deliberately indistinguishable from "not_found"
}
