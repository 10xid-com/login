import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ session: vi.fn(), account: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/login", () => ({ getLoginSession: m.session }));
vi.mock("@/lib/db/accounts", () => ({ userByAuthUserId: m.account }));
vi.mock("@/lib/auth/auth", () => ({ loginOrigin: () => "https://login.10xid.com" }));
vi.mock("@/app/auth/auth-card", () => ({ AuthCard: ({ children }: { children: unknown }) => children }));
vi.mock("@/app/auth/flow-ui", () => ({ TextLink: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never) }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DeckPage from "@/app/auth/pid/my-work/[deck]/page";
import { readFileSync } from "node:fs";
import { isMyWorkPath } from "@/lib/pid/my-work-paths";
import { loadCardFile, loadMyDeck, loadMyWork, trustedOrigin } from "@/lib/pid/my-work";
import { myWorkActor } from "@/lib/pid/my-work-session";
import { GET as contentGet } from "@/app/api/pid/my-work/[deck]/cards/[card]/content/route";
import { GET as fileGet } from "@/app/api/pid/my-work/[deck]/cards/[card]/content/files/[file]/route";
import { GET as assetsGet } from "@/app/api/uid/assets/route";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const DECK = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";
const SECRET = "a".repeat(64);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  process.env.CID_WORK_DECKS_SECRET = SECRET;
  delete process.env.CONTROL_ROOM_ORIGIN;
  delete process.env.CLOTHING_UI_HOST;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  m.session.mockResolvedValue({ mfaVerifiedAt: new Date(), user: { id: "auth-1" } });
  m.account.mockResolvedValue({ id: ACTOR });
});
afterEach(() => vi.unstubAllGlobals());

const route = (deck = DECK, card = "card_1", file = FILE) => ({ params: Promise.resolve({ deck, card, file }) });

describe("trusted origin", () => {
  it("accepts only plain https 10xid.com origins", () => {
    expect(trustedOrigin({} as NodeJS.ProcessEnv)).toBe("https://uid-bypaolo.10xid.com");
    expect(trustedOrigin({ CONTROL_ROOM_ORIGIN: "https://evil.example.com" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(trustedOrigin({ CONTROL_ROOM_ORIGIN: "http://a.10xid.com" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(trustedOrigin({ CONTROL_ROOM_ORIGIN: "https://a.10xid.com/x" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(trustedOrigin({ CONTROL_ROOM_ORIGIN: "https://u:p@a.10xid.com" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(trustedOrigin({ CONTROL_ROOM_ORIGIN: "https://a.10xid.com.evil.io" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("loadMyWork", () => {
  it("sends only the session actor and the fixed path, no-store, no redirects", async () => {
    fetchMock.mockResolvedValue(json({ userId: ACTOR, businesses: [], decks: [], order: [] }));
    const result = await loadMyWork(ACTOR);
    expect(result).toEqual({ ok: true, value: { businesses: [], decks: [] } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://uid-bypaolo.10xid.com/internal/pid-my-work");
    expect(init.headers["x-10xid-account"]).toBe(ACTOR);
    expect(init.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
  });

  it("orders decks, strips contact details, and ignores unknown fields", async () => {
    fetchMock.mockResolvedValue(
      json({
        userId: ACTOR,
        businesses: [{ id: "b1", name: "Rotary", secret: "x" }],
        decks: {
          [DECK]: {
            id: DECK, title: "Spring", stage: "Build", status: "Active", due: "2026-12-01", action: "Review", nextAction: "Sign off",
            owner: { name: "Rana", email: "rana@example.com", phone: "555" },
            participants: [{ name: "Ethan", email: "e@example.com" }, "x@example.com", "Paolo"],
            internalNotes: "hidden",
          },
        },
        order: [DECK],
      }),
    );
    const result = await loadMyWork(ACTOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const deck = result.value.decks[0];
    expect(deck.owner).toBe("Rana");
    expect(deck.participants).toEqual(["Ethan", "Paolo"]);
    expect(deck.nextAction).toBe("Sign off");
    expect(JSON.stringify(result.value)).not.toMatch(/example\.com|555|hidden|secret/);
  });

  it("treats an answer for a different person as unavailable, not as an empty list", async () => {
    fetchMock.mockResolvedValue(json({ userId: "99999999-9999-4999-8999-999999999999", decks: [], order: [] }));
    expect(await loadMyWork(ACTOR)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("distinguishes unavailable from empty", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    expect(await loadMyWork(ACTOR)).toEqual({ ok: false, reason: "unavailable" });
    fetchMock.mockRejectedValue(new Error("network"));
    expect(await loadMyWork(ACTOR)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("is unavailable without a valid secret or a valid actor id, and makes no request", async () => {
    process.env.CID_WORK_DECKS_SECRET = "short";
    expect(await loadMyWork(ACTOR)).toEqual({ ok: false, reason: "unavailable" });
    process.env.CID_WORK_DECKS_SECRET = SECRET;
    expect(await loadMyWork("not-a-uuid")).toEqual({ ok: false, reason: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("loadMyDeck", () => {
  it("rejects a malformed id without calling upstream", async () => {
    expect(await loadMyDeck(ACTOR, "../../etc")).toEqual({ ok: false, reason: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps upstream 403 and 404 to not found, never to an empty deck", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));
    expect((await loadMyDeck(ACTOR, DECK)).ok).toBe(false);
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    expect((await loadMyDeck(ACTOR, DECK)).ok).toBe(false);
  });

  it("returns the requested deck and refuses a different one", async () => {
    fetchMock.mockResolvedValue(json({ deck: { id: DECK, title: "T", due: "soon" } }));
    const ok = await loadMyDeck(ACTOR, DECK);
    expect(ok.ok && ok.value.title).toBe("T");
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://uid-bypaolo.10xid.com/internal/pid-my-work/${DECK}`);
    fetchMock.mockResolvedValue(json({ deck: { id: FILE, title: "Other" } }));
    expect((await loadMyDeck(ACTOR, DECK)).ok).toBe(false);
  });
});

describe("actor resolution", () => {
  it("uses only the session's own account", async () => {
    expect(await myWorkActor()).toEqual({ state: "ok", actorId: ACTOR });
    expect(m.account).toHaveBeenCalledWith("auth-1");
  });
  it("requires a session, the authenticator, and a bound account", async () => {
    m.session.mockResolvedValue(null);
    expect((await myWorkActor()).state).toBe("signed_out");
    m.session.mockResolvedValue({ mfaVerifiedAt: null, user: { id: "auth-1" } });
    expect((await myWorkActor()).state).toBe("needs_mfa");
    m.session.mockResolvedValue({ mfaVerifiedAt: new Date(), user: { id: "auth-1" } });
    m.account.mockResolvedValue(null);
    expect((await myWorkActor()).state).toBe("no_account");
  });
});

describe("card content and file routes", () => {
  it("refuse signed-out and pre-MFA callers without contacting upstream", async () => {
    m.session.mockResolvedValue(null);
    expect((await contentGet(new Request("https://login.10xid.com/x"), route())).status).toBe(401);
    m.session.mockResolvedValue({ mfaVerifiedAt: null, user: { id: "auth-1" } });
    expect((await fileGet(new Request("https://login.10xid.com/x"), route())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a client-supplied actor and builds the upstream path itself", async () => {
    fetchMock.mockResolvedValue(json({ blocks: [] }));
    const request = new Request("https://login.10xid.com/x?userId=evil&account=evil", { headers: { "x-10xid-account": "evil" } });
    const response = await contentGet(request, route());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://uid-bypaolo.10xid.com/internal/pid-my-work/${DECK}/cards/card_1/content`);
    expect(init.headers["x-10xid-account"]).toBe(ACTOR);
  });

  it("rejects path-shaped ids and returns 404 for unauthorized decks", async () => {
    expect((await contentGet(new Request("https://login.10xid.com/x"), route(DECK, "a/../b"))).status).toBe(404);
    expect((await contentGet(new Request("https://login.10xid.com/x"), route("nope"))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));
    expect((await contentGet(new Request("https://login.10xid.com/x"), route())).status).toBe(404);
    fetchMock.mockResolvedValue(new Response("", { status: 502 }));
    expect((await contentGet(new Request("https://login.10xid.com/x"), route())).status).toBe(503);
  });

  it("previews only safe types inline and forces everything else to download", async () => {
    fetchMock.mockResolvedValue(new Response("png", { headers: { "content-type": "image/png" } }));
    const preview = await fileGet(new Request("https://login.10xid.com/x?preview=1"), route());
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/files\/3333[^?]*\?preview=1$/);
    expect(preview.headers.get("content-disposition")).toBe("inline");
    expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
    expect(preview.headers.get("cache-control")).toBe("private, no-store");

    fetchMock.mockResolvedValue(new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }));
    const svg = await fileGet(new Request("https://login.10xid.com/x?preview=1"), route());
    expect(svg.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(svg.headers.get("content-type")).toBe("application/octet-stream");

    fetchMock.mockResolvedValue(new Response("png", { headers: { "content-type": "image/png" } }));
    const download = await loadCardFile(ACTOR, DECK, "card_1", FILE, false);
    expect(download.ok && download.value.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(String(fetchMock.mock.calls.at(-1)![0])).not.toContain("preview");
  });
});

describe("sign-in return path and launcher", () => {
  it("resumes only the My Work list or a UUID deck", () => {
    expect(isMyWorkPath("/auth/pid/my-work")).toBe(true);
    expect(isMyWorkPath(`/auth/pid/my-work/${DECK}`)).toBe(true);
    expect(isMyWorkPath("/auth/pid/my-work/x")).toBe(false);
    expect(isMyWorkPath(`/auth/pid/my-work/${DECK}/extra`)).toBe(false);
    expect(isMyWorkPath("/auth/pid/my-workx")).toBe(false);
  });

  it("serves members.js with the Login origin filled in", async () => {
    const response = await assetsGet(new Request("https://login.10xid.com/api/uid/assets?file=members.js"));
    const body = await response.text();
    expect(body).toContain("const LOGIN_ORIGIN='https://login.10xid.com'");
    expect(body).not.toContain("%%LOGIN_ORIGIN%%',loginOrigin");
    expect(body).toContain("/auth/pid/my-work");
  });
});

describe("actual {deck,events} detail: stage notes, files and history", () => {
  const CARD_FILE = "44444444-4444-4444-8444-444444444444";
  const detail = {
    deck: { id: DECK, title: "Club shirts", stage: "Design", status: "Active", due: "2026-12-01", nextAction: "Approve", owner: "Rana", participants: ["Ethan"] },
    events: [
      { id: "e1", at: "2026-11-01T10:00:00Z", type: "handoff", from: "Pricing", to: "Design", actorId: "99999999-9999-4999-8999-999999999999", note: "Artwork <b>ready</b>" },
      { id: "e2", createdAt: "2026-10-30", from: "Enquiry", to: "Pricing" },
    ],
  };
  const render = async (stage?: string) =>
    renderToStaticMarkup(await DeckPage({ params: Promise.resolve({ deck: DECK }), searchParams: Promise.resolve({ stage }) }));

  it("keeps handoff history as plain text without actor ids", async () => {
    fetchMock.mockResolvedValue(json(detail));
    const result = await loadMyDeck(ACTOR, DECK);
    expect(result.ok && result.value.history).toEqual([
      { at: "2026-11-01T10:00:00Z", text: "Artwork <b>ready</b>" },
      { at: "2026-10-30", text: "Enquiry to Pricing" },
    ]);
    expect(JSON.stringify(result)).not.toContain("99999999");
  });

  it("fetches only the current stage card (Design = 4) and renders notes, files and history safely", async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).endsWith("/content")
        ? json({ notes: [{ text: "Use <script>x</script> blue" }], files: [{ id: CARD_FILE, name: "logo.png", secret: "no" }] })
        : json(detail),
    );
    const html = await render();
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).toEqual([
      `https://uid-bypaolo.10xid.com/internal/pid-my-work/${DECK}`,
      `https://uid-bypaolo.10xid.com/internal/pid-my-work/${DECK}/cards/4/content`,
    ]);
    expect(html).toContain("Use &lt;script&gt;x&lt;/script&gt; blue");
    expect(html).not.toContain("<script>");
    expect(html).toContain(`/api/pid/my-work/${DECK}/cards/4/content/files/${CARD_FILE}?preview=1`);
    expect(html).toContain("Artwork &lt;b&gt;ready&lt;/b&gt;");
    expect(html).not.toContain("99999999");
    expect(html).not.toContain("no<");
  });

  it("loads a chosen stage on demand and ignores bad stage values", async () => {
    fetchMock.mockImplementation(async (url: URL) => (String(url).endsWith("/content") ? json({ blocks: ["Quote sent"] }) : json(detail)));
    expect(await render("2")).toContain("Quote sent");
    expect(String(fetchMock.mock.calls.at(-1)![0])).toMatch(/\/cards\/2\/content$/);
    fetchMock.mockClear();
    await render("../9");
    expect(String(fetchMock.mock.calls.at(-1)![0])).toMatch(/\/cards\/4\/content$/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses an inline card when upstream supplies one, and survives a failed stage", async () => {
    const inline = { deck: { ...detail.deck, cards: [{ id: "77", title: "Design", files: [{ id: CARD_FILE, name: "inline.pdf" }] }] }, events: [] };
    fetchMock.mockImplementation(async (url: URL) => (String(url).endsWith("/content") ? new Response("", { status: 502 }) : json(inline)));
    const html = await render();
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/cards\/77\/content$/);
    expect(html).toContain("This stage could not be loaded");
    expect(html).not.toContain("Handoff history");
  });
});

describe("PiD home", () => {
  it("links straight to My Work, in the section nav and in the Work section", () => {
    const source = readFileSync("app/auth/pid/page.tsx", "utf8");
    expect(source.match(/href="\/auth\/pid\/my-work"/g)).toHaveLength(2);
  });
});
