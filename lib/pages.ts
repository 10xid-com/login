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
 * Retired, never to be reused: `sign-in`, `sign-up`, `code`, `authenticator`
 * and `recovery` — the emailed-code sign-in, replaced by the self-hosted sign-in
 * (`login.*`) in October 2026.
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
    id: "login.sign-in",
    path: "/auth/sign-in",
    name: "Sign in",
    purpose: "Password, emailed code, Google or Microsoft — then always the authenticator app.",
    audience: "public",
    kind: "page",
    file: "app/auth/sign-in/page.tsx",
    group: "Getting in",
  },
  {
    id: "login.sign-in-code",
    path: "/auth/sign-in/code",
    name: "Sign in with a code",
    purpose: "Passwordless: a six-digit code by email, then the authenticator.",
    audience: "public",
    kind: "page",
    file: "app/auth/sign-in/code/page.tsx",
    group: "Getting in",
  },
  {
    id: "login.sign-up",
    path: "/auth/sign-up",
    name: "Create your sign-in",
    purpose: "For an invited address. Grants nothing until the address is confirmed and the authenticator set up.",
    audience: "public",
    kind: "page",
    file: "app/auth/sign-up/page.tsx",
    group: "Getting in",
  },
  {
    id: "login.verify-email",
    path: "/auth/verify-email",
    name: "Confirm your email",
    purpose: "Type the emailed code that proves you hold the inbox.",
    audience: "public",
    kind: "page",
    file: "app/auth/verify-email/page.tsx",
    group: "Getting in",
  },
  {
    id: "login.forgot-password",
    path: "/auth/forgot-password",
    name: "Forgot password",
    purpose: "Asks for a reset code by email.",
    audience: "public",
    kind: "page",
    file: "app/auth/forgot-password/page.tsx",
    group: "Getting in",
  },
  {
    id: "login.reset-password",
    path: "/auth/reset-password",
    name: "New password",
    purpose: "Code plus new password. Signs out every session.",
    audience: "public",
    kind: "page",
    file: "app/auth/reset-password/page.tsx",
    group: "Getting in",
  },
  {
    id: "login.mfa",
    path: "/auth/mfa",
    name: "Authenticator code",
    purpose: "The second step after every way of signing in.",
    audience: "public",
    kind: "page",
    file: "app/auth/mfa/page.tsx",
    group: "Getting in",
  },
  {
    id: "login.mfa-setup",
    path: "/auth/mfa/setup",
    name: "Set up authenticator",
    purpose: "Scan, confirm with the first code, save the recovery codes shown once.",
    audience: "public",
    kind: "page",
    file: "app/auth/mfa/setup/page.tsx",
    group: "Getting in",
  },
  {
    id: "login.recovery-codes",
    path: "/auth/mfa/recovery-codes",
    name: "Your recovery codes",
    purpose: "Shown once, right after they are made. Never in a URL; the copy that carries them here dies in ten minutes.",
    audience: "public",
    kind: "page",
    file: "app/auth/mfa/recovery-codes/page.tsx",
    group: "Getting in",
  },
  {
    id: "login.mfa-recover",
    path: "/auth/mfa/recover",
    name: "Recovery code",
    purpose: "Pass the authenticator step with a one-time recovery code.",
    audience: "public",
    kind: "page",
    file: "app/auth/mfa/recover/page.tsx",
    group: "Getting in",
  },
  {
    id: "login.access",
    path: "/auth/access",
    name: "Access",
    purpose: "Signed in, but what is still missing before 10XiD opens: a confirmed address, an invitation, or an operator's confirmation.",
    audience: "public",
    kind: "page",
    file: "app/auth/access/page.tsx",
    group: "Getting in",
  },
  /* -------------------------------------------------------------- */
  /* The work                                                        */
  /* -------------------------------------------------------------- */

  /* -------------------------------------------------------------- */
  /* Your account                                                    */
  /* -------------------------------------------------------------- */
  {
    id: "login.account",
    path: "/auth/account",
    name: "Your sign-in",
    purpose: "Sessions, signing out everywhere, authenticator, recovery codes, linked providers.",
    audience: "member",
    kind: "page",
    file: "app/auth/account/page.tsx",
    group: "Your account",
  },

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
  },  {
    id: "login.auth-api",
    path: "/api/auth/[...all]",
    name: "Sign-in engine",
    purpose: "Better Auth, self-hosted: the endpoints the sign-in screens and the Google and Microsoft callbacks use.",
    audience: "public",
    kind: "machinery",
    file: "app/api/auth/[...all]/route.ts",
    methods: ["GET", "POST"],
    group: "Machinery",
  },
  {
    id: "login.healthz",
    path: "/healthz",
    name: "Healthcheck",
    purpose: "Unauthenticated liveness for the platform. Answers ok and nothing else.",
    audience: "public",
    kind: "machinery",
    file: "app/healthz/route.ts",
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
