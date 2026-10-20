# 10XiD Login

Sign-in for 10XiD, at **`login.10xid.com`**, and the owner of the database schema and its
migrations. The portal — dashboard, jobs, the staff workspace, team and account screens — is
[`10xid-com/app`](https://github.com/10xid-com/app), at **`app.10xid.com`**.

**The portal signs people in itself** (an emailed code, then an authenticator app, every time;
see that repository's README). It is not tied to this host: nothing here sends anyone to it, and
this host mints it no tickets. To keep it that way, `PORTAL_HOST` is left unset on this service
and `app.10xid.com` is listed in `PORTAL_RETIRED_DOMAINS`, which takes its row out of
`organization_domains` on deploy (see "The portal is untied" below).

This app shows only `/auth/*` (plus `/api/auth/*` and `/healthz`): sign-in, creating a
sign-in for an invitation, emailed codes, the authenticator and recovery codes, the account's
sessions, the UiD sign-in (`/auth/uid/*`), and `/auth/sso/authorize`, where the cross-domain
handoff mints its ticket for a registered domain. Signing in ends at the person's UiD
(`UID_HOMES`) or, for everybody else, on this host's own account page — or at the portal again,
only if `PORTAL_HOST` is ever set.

Both apps use **one database**. Its schema (`lib/db/schema.ts`) and migrations
(`drizzle/`) live here; `10xid-com/app` carries an identical copy of the schema file,
which its CI compares against this repository's `main`. A schema change is made here,
with its migration, and then copied there unchanged.

| Service | Repository | Custom domain |
|---|---|---|
| `portal` — the login host | `10xid-com/login` | `login.10xid.com` |
| `app` — the portal, with its own sign-in | `10xid-com/app` | `app.10xid.com` |

### The portal is untied

Until 2026-10-20 the portal received its sessions from this host by the ticket handoff. It now
signs people in itself, and refuses any session that was handed over. On the `portal` service:

- `PORTAL_HOST` — **unset**. With it unset, nothing here redirects to the portal, and signing
  in ends on `/auth/account` (or the person's UiD).
- `PORTAL_RETIRED_DOMAINS` — includes `app.10xid.com`, so the deploy step deletes its
  `organization_domains` row and no ticket can be minted for it. The step refuses to retire a
  host that is still `PORTAL_HOST`, so unset that first.

A custom domain on Railway needs two records in Cloudflare, not one: the CNAME that
routes traffic, and a `_railway-verify.<name>` TXT record proving ownership. With only
the CNAME, the certificate sits at "issuing" indefinitely and browsers refuse the address.

### Where signing in ends

At the person's UiD, if they have one; otherwise on this host's account page (`/auth/account`). `UID_HOMES` on the login service lists
them: `address=https://…` pairs, comma-separated, the address being the portal account's
(`paolo@10xid.com=https://uid-bypaolo.10xid.com/v3/,…`). Once that account's identity is past the
authenticator, `/` on the login host (`app/page.tsx`) sends it to its UiD; a signed-in visit to
login.10xid.com does the same. Anybody not listed lands on `/auth/account`. Only https addresses on a 10xid.com subdomain other than the login
host are accepted (`lib/auth/uid-home.ts`). Being sent there is a redirect; signing in on a UiD page is
the next section.

### UiD pages sign in here

A UiD page (`uid-rana.10xid.com`, `uid-bypaolo.10xid.com`) is a small service of its own with no
database. It signs people in the way a client domain does, by a single-use ticket, with one
difference: its server redeems the ticket here, server to server, rather than in the database.

1. With no session of its own, the UiD sends the browser to `/auth/uid/authorize?host=…&state=…`.
2. Here: a sign-in session, past the authenticator, bound to a portal account, and `UID_SITES`
   letting that account open that UiD. Then a ticket bound to that host, for 30 seconds, back to
   `https://<host>/auth/callback`.
3. The UiD's server posts the ticket to `/api/uid/redeem` with `Authorization: Bearer
   <its secret>` and gets back who signed in, and the sign-in session it came from.
4. Every few minutes it asks `/api/uid/alive` whether that sign-in is still live
   (`auth_session_touch`, as the portal does), so signing out here ends it there too.

`UID_SITES` lists each UiD and who may open it (`host=address|address`, comma-separated);
`UID_SITE_KEY` derives each UiD's secret from its host (`uidSiteSecret` in
`lib/auth/uid-sites.ts`), which that UiD's service holds as `UID_SITE_SECRET`. One key here
serves every UiD, and no UiD can redeem another's tickets. Without the key, no UiD signs in.

`app.10xid.com` and `login.10xid.com` are siblings, but each one's session cookie is `__Host-`
prefixed and so is never shared between them. That is deliberate — a cookie scoped to
`.10xid.com` could be read or overwritten by any other subdomain.

## Sign-in: self-hosted Better Auth (0022)

Sign-in runs **here**, on Railway, with no authentication provider: [Better Auth](https://better-auth.com)
(MIT) under `/api/auth`, behind this app's own branded pages under `/auth/*`. Password,
emailed codes (through Resend), Google and Microsoft — and an authenticator app after **every**
one of them. A signed-in, authenticator-verified identity that is bound to a portal account
opens the person's UiD pages; being signed in grants nothing by itself. (It used to be handed
to `app.10xid.com` too; the portal now signs people in itself — "The portal is untied" above.)

Its tables (`auth_*`) belong to their own restricted role, `portal_auth` (`AUTH_DATABASE_URL`);
the portal's role cannot read them. A sign-in lasts until the person signs out: there is no
inactivity limit, and each use moves its end 400 days out (the browser's own cookie ceiling).
Postgres enforces that (0037). The full design, the Railway variables, provider setup, deployment order
and rollback are in **[`docs/better-auth-cutover.md`](docs/better-auth-cutover.md)**.

An operator answers binding requests (an account from before, signing in for the first time)
on **`/auth/operator`** — confirm or reject, invite somebody into a business, reset a lost
authenticator. Operators are the portal accounts listed in `OPERATOR_EMAILS` on the login
service; each action needs the authenticator within five minutes, and goes through
`operator_*` database functions (0023) that only the login service's sign-in role may call. The
same answers are available from a terminal, connecting as the owner:

```bash
npm run identity:bindings -- list
npm run identity:bindings -- confirm <request id> --operator "Full Name"
npm run identity:bindings -- reject  <request id> --operator "Full Name"
npm run identity:bindings -- reset-authenticator <email> --operator "Full Name"
npm run identity:bindings -- sign-out-everywhere <email> --operator "Full Name"
```

Confirm only after checking with the person by another channel (a call to a number already on
file) that they are the one who just signed in.

The tests: `test/better-auth.test.ts` (the engine, the gate, the clocks, revocation, tickets, as
each database role) and `test/e2e/better-auth.spec.ts` (both hosts in a real browser).

## What it does

- **Sign in once** at the login host, then land already signed in on a site at a
  **genuinely different registrable domain**, with no second prompt, via a single-use
  ticket handoff.
- **An authenticator after every way in.** Password, emailed code, Google or Microsoft is
  only the first step; the second is always an authenticator app, with ten single-use
  recovery codes issued at enrolment.
- **Accounts are by invitation**, never by open registration — a portal holds several
  companies' data, and an address typed into a form says nothing about which company its
  owner belongs to.

Everything else — requests, jobs, the workspace, API keys — is the portal's, and is
described in `10xid-com/app`.

## The rule everything else serves

**Every database read and write is scoped to the signed-in person's company**, through one
shared helper that takes the session and returns an already-scoped query. It is enforced
twice, deliberately, because the two layers fail differently:

- `lib/db/index.ts` — the only surface the application may use. Every function takes the
  scope first, so there is no unscoped variant to reach for in a hurry. An ESLint rule
  fails the build if anything outside `lib/db/` imports the connection module.
- Postgres row-level security underneath — which catches what the helper cannot, notably
  a nested relation load applying its own filter.

The application **refuses to start** if its database role is a superuser, can bypass
row-level security, or owns the tables. That is the case where Postgres silently ignores
every policy and an isolation test passes while proving nothing.

`npm run db:rls-check` fails the build if a new table carries an organization id without
either a policy or a written exemption. It has caught two tables so far.

## Running it locally

Needs Node 22+, PostgreSQL 16, and a checkout of `10xid-com/app` next to this one
(`../app`): signing in ends on the portal.

```bash
npm install
cp .env.example .env.local        # then fill in the two connection strings

npm run db:migrate                # runs as the OWNER
npm run db:seed                   # two client companies, one internal, three people
PORTAL_HOST=app.portal-a.test:3001 npm run dev    # this app, on :3000
(cd ../app && npm run dev -- -p 3001)              # the portal, on :3001
```

Two connection strings, and they must differ: `DATABASE_URL` owns the tables and runs
migrations, `DATABASE_APP_URL` is the restricted role the application connects as.

Sign-in codes are not emailed in development — they are appended to
`/tmp/portal-signin-codes.log` and printed to the server log. In production the mailer
**refuses** to fall back to that, rather than writing codes to disk where they might be
read.

### The domains

```
127.0.0.1  login.portal-a.test      # this app, :3000 — the only place sign-in happens
127.0.0.1  app.portal-a.test        # the portal (10xid-com/app), :3001
127.0.0.1  rotary.portal-b.test     # a client domain, served by the portal, :3001
127.0.0.1  northstar.portal-b.test  # a second client, so isolation has a target, :3001
```

portal-a.test and portal-b.test are different registrable domains, so cross-domain
sign-in is tested for real. `app` and `login` are siblings under one domain, as in
production, and still share no cookie: it is `__Host-` prefixed.

## Email

`RESEND_API_KEY`. Without it, development writes codes to a file and production refuses
to start the flow.

## Proving it

```bash
npm test          # unit and database tests, as the restricted role, against real Postgres
npm run test:e2e  # browser tests across Chrome and Firefox, normal and fresh profiles;
                  # starts this app on :3000 and the portal (E2E_APP_DIR, default ../app) on :3001
```

## Measured, not assumed

| | Chrome | Chrome (fresh) | Firefox | Firefox (fresh) |
|---|---|---|---|---|
| Cross-domain handoff | 506ms | 494ms | 791ms | 858ms |
| Sign-out propagation | 257ms | 282ms | 405ms | 421ms |

Sign-out ends the session on every domain in one request, because the session row is
revoked and there is no short-lived token left alive to outlive it.

**Safari is not tested**, by decision. A Linux container cannot run it, and the nearest
engine available is not the same thing where it matters.

## Conventions worth knowing

- **Next.js 16 renamed middleware to `proxy.ts`.** Here it keeps `/auth/*` and sends
  every other path to the portal (`PORTAL_HOST`), asking a visitor with no session to sign
  in first. It deliberately does not validate sessions — that belongs in the data layer.
- **Versions are pinned exactly.** Drizzle's documentation site describes 1.0 while npm
  installs 0.45.2 with a different migration layout, so a caret produces a build that
  does not match its own documentation.
- **Job ids in URLs are UUIDv7**, generated in application code because Postgres 16 has no
  native `uuidv7()`. The human reference (`ROT-0042`) is per-client sequential and never
  appears in a URL, since it would otherwise leak how many jobs a client has.
- **The hostname decides branding, never permission.** What a person may read comes from
  their session. The address bar carries no authority.
- **Sessions last until they are signed out.** Both clocks are off; the stored expiry is
  the browser's own 400-day cookie ceiling rather than a policy. What bounds a staff
  session is reach, not time — one client at a time, through a grant that lapses.

## The decision record

`docs/portal-architecture.html` — cross-domain sign-in, sessions, tenancy, the data model,
DNS, phases, costs and risks, with the reasoning for each.

Published: <https://claude.ai/artifact/Vzzyh8w5Re9zafx7kef75G> (written before the build;
the session-lifetime section has since been revised in the repo copy).
