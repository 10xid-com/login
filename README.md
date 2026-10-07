# 10XiD Login

Sign-in for 10XiD, at **`login.10xid.com`**, and the owner of the database schema and its
migrations. The portal itself — dashboard, jobs, the staff workspace, team and account
screens — is [`10xid-com/app`](https://github.com/10xid-com/app), at **`app.10xid.com`** and on
the client domains.

This app shows only `/auth/*`: sign-in, accepting an invitation, the emailed code, the
staff authenticator and recovery codes, and `/auth/sso/authorize`, where the cross-domain
handoff mints its ticket. Any other address is sent to the portal (`PORTAL_HOST`), and
signing in ends there. A portal host or client domain with no session sends the browser
here and gets it back signed in, with no second prompt.

Both apps use **one database**. Its schema (`lib/db/schema.ts`) and migrations
(`drizzle/`) live here; `10xid-com/app` carries an identical copy of the schema file,
which its CI compares against this repository's `main`. A schema change is made here,
with its migration, and then copied there unchanged.

| Service | Repository | Custom domain |
|---|---|---|
| `portal` — the login host | `10xid-com/login` | `login.10xid.com` |
| the portal | `10xid-com/app` | `app.10xid.com` |
| a client domain | `10xid-com/app` | `northstar.10xconnections.com` |

A custom domain on Railway needs two records in Cloudflare, not one: the CNAME that
routes traffic, and a `_railway-verify.<name>` TXT record proving ownership. With only
the CNAME, the certificate sits at "issuing" indefinitely and browsers refuse the address.

To register the portal host as a handoff destination, as the owner connection:

```sql
insert into organization_domains (organization_id, hostname, is_primary, verified_at)
select id, 'app.10xid.com', false, now() from organizations where type = 'internal';
```

## What it does

- **Sign in once** at the login host, then land already signed in on a site at a
  **genuinely different registrable domain**, with no second prompt, via a single-use
  ticket handoff.
- **No passwords anywhere.** A first-time account gets a six-digit emailed code; once an
  authenticator is enrolled, that code is what signs the account in and **the emailed code
  stops working for it**. Ten single-use recovery codes are issued at enrolment.
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
