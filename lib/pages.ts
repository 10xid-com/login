/**
 * Every page this service has, and the iD each one answers to.
 *
 * The portal's pages are 10xid-com/app's and are listed in its copy of this
 * file, which is also where the desk that renders this list lives. Their iDs
 * are theirs: never reuse them here.
 *
 * The reason this file exists rather than a list typed into a screen: a path is
 * where something lives today, and an iD is what it IS. `/dashboard` may well
 * become `/desk` — it is called a desk in conversation already — and when it
 * does, every link, bookmark and note that said "dashboard" is wrong, while
 * anything that said the iD `dashboard` still points at the right thing. That
 * is the same argument the product makes about people: an email address is
 * where you can be reached and changes, an iD is who you are and does not.
 *
 * So an iD here is STABLE. When a path moves, change `path` and leave `id`
 * alone. When a page is retired, take the row out but never hand its iD to
 * something else — the identities table holds the same rule for people, where
 * `id_code` is unique across every row the table has ever held, revoked ones
 * included.
 *
 * Nothing foreign-keys to these codes, deliberately, for the same reason
 * nothing foreign-keys to `identities.id_code`. An iD is a public handle, not a
 * primary key.
 *
 * `file` is not documentation. It is what test/pages-desk.test.ts compares
 * against the actual contents of app/, so a page added without a row here — or
 * a row left behind after a page is deleted — fails the suite rather than
 * quietly making the desk a lie. A hand-maintained inventory with no such test
 * is wrong within a month.
 */

/** Who can get to it at all. */
export type Audience =
  /** No session needed — these are the ways in. */
  | "public"
  /** Any signed-in person. */
  | "member"
  /** Staff only. A client account is redirected away. */
  | "staff";

export type Kind =
  /** A screen a person reads. */
  | "page"
  /** A URL with no screen: a redirect, a handoff, a machine endpoint. */
  | "machinery";

export interface PageRecord {
  /** The iD. Stable forever — see the note at the top of this file. */
  id: string;
  /** Where it lives today. Change this freely; never change `id` with it. */
  path: string;
  name: string;
  /** One line, in plain words, about what it is for. */
  purpose: string;
  audience: Audience;
  kind: Kind;
  /** Which file implements it. Checked against app/ by the test. */
  file: string;
  /** Machinery only: the methods it actually answers. */
  methods?: string[];
  /** The heading it sits under on the desk. */
  group: Group;
}

export const GROUPS = [
  "Getting in",
  "The work",
  "Your account",
  "Staff",
  "Machinery",
] as const;

export type Group = (typeof GROUPS)[number];

export const PAGES: PageRecord[] = [
  /* -------------------------------------------------------------- */
  /* Getting in                                                      */
  /* -------------------------------------------------------------- */
  {
    // Not "front-door": that iD is the portal's "/", which decides where you
    // belong, and it stays with the portal in 10xid-com/app.
    id: "login-front-door",
    path: "/",
    name: "Login front door",
    purpose:
      "Sends you on to the portal. The login host has nothing else to show, and no public landing page.",
    audience: "public",
    kind: "machinery",
    file: "app/page.tsx",
    group: "Getting in",
  },
  {
    id: "sign-in",
    path: "/auth/login",
    name: "Sign in",
    purpose: "Give your email address and we post you a six-digit code. No password exists to type.",
    audience: "public",
    kind: "page",
    file: "app/auth/login/page.tsx",
    group: "Getting in",
  },
  {
    id: "sign-up",
    path: "/auth/signup",
    name: "Accept an invitation",
    purpose: "Where an invited person turns their invitation into an account.",
    audience: "public",
    kind: "page",
    file: "app/auth/signup/page.tsx",
    group: "Getting in",
  },
  {
    id: "code",
    path: "/auth/verify",
    name: "Six-digit code",
    purpose: "Type the code from the email. Proves you hold the inbox.",
    audience: "public",
    kind: "page",
    file: "app/auth/verify/page.tsx",
    group: "Getting in",
  },
  {
    id: "authenticator",
    path: "/auth/2fa",
    name: "Authenticator",
    purpose:
      "The second factor. Staff reach every client's data, and an inbox is the thing most likely to be taken, so holding it is not enough on its own.",
    audience: "public",
    kind: "page",
    file: "app/auth/2fa/page.tsx",
    group: "Getting in",
  },
  {
    id: "recovery",
    path: "/auth/recovery-codes",
    name: "Recovery codes",
    purpose:
      "The one-time list shown when you enrol an authenticator. It is the answer to losing the phone, and it is shown once.",
    audience: "public",
    kind: "page",
    file: "app/auth/recovery-codes/page.tsx",
    group: "Getting in",
  },

  /* -------------------------------------------------------------- */
  /* The work                                                        */
  /* -------------------------------------------------------------- */

  /* -------------------------------------------------------------- */
  /* Your account                                                    */
  /* -------------------------------------------------------------- */

  /* -------------------------------------------------------------- */
  /* Staff                                                           */
  /* -------------------------------------------------------------- */

  /* -------------------------------------------------------------- */
  /* Machinery                                                       */
  /* -------------------------------------------------------------- */
  {
    id: "sso.authorize",
    path: "/auth/sso/authorize",
    name: "Handoff — authorize",
    purpose:
      "The login host mints a single-use ticket, hashed at rest and bound to the one host that asked for it.",
    audience: "public",
    kind: "machinery",
    file: "app/auth/sso/authorize/route.ts",
    methods: ["GET"],
    group: "Machinery",
  },
];

/**
 * What one person should be shown.
 *
 * Staff see everything. A client account sees the pages it can actually reach,
 * because listing `/staff/keys` to somebody who is redirected away from it is
 * not an inventory, it is a locked door with a label on it.
 */
export function pagesFor(isStaff: boolean): PageRecord[] {
  return isStaff ? PAGES : PAGES.filter((p) => p.audience !== "staff");
}

/** How many rows a client account is not being shown. */
export function hiddenFrom(isStaff: boolean): number {
  return isStaff ? 0 : PAGES.length - pagesFor(false).length;
}

/** Look one up by its iD. */
export function pageById(id: string): PageRecord | undefined {
  return PAGES.find((p) => p.id === id);
}
