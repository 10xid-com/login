# 10XiD Portal

One sign-in across several domains, and a job exchange between Branding Centres and its
clients — replacing the email thread that carries that work today.

**Status: deployed.** Two Railway services build from `main`, each with a custom domain and
a Railway address:

| Service | Custom domain | Railway address | Port |
|---|---|---|---|
| `portal` — the login host | `login.10xid.com` | `portal-production-56c9.up.railway.app` | 8080 |
| `portal-northstar` — a client domain | `northstar.10xconnections.com` | `portal-northstar-production.up.railway.app` | 3000 |

The two custom domains are genuinely different registrable domains, which is what makes
the cross-domain handoff a real test. Both carry a valid certificate. A custom domain on
Railway needs two records in Cloudflare, not one: the CNAME that routes traffic, and a
`_railway-verify.<name>` TXT record proving ownership. With only the CNAME, the
certificate sits at "issuing" indefinitely and browsers refuse the address.

### Moving the portal to `app.10xid.com`

The portal pages (dashboard, chat, jobs, team, staff…) can live on a host of their own,
leaving `login.10xid.com` with nothing but sign-in. `PORTAL_HOST` switches this on; unset,
nothing changes, so the code can be deployed before any of the steps below.

`app.10xid.com` is a sibling of `login.10xid.com`, but the session cookie is `__Host-`
prefixed and so is never shared between them. That is deliberate — a cookie scoped to
`.10xid.com` could be read or overwritten by any other subdomain. The portal host gets its
own session through the same handoff a client domain uses, with no second prompt.

1. **Domain.** Add `app.10xid.com` as a second custom domain on the `portal` service (or on
   a new service built from `main`, with the same environment). In Cloudflare: the CNAME,
   and the `_railway-verify.app` TXT record.
2. **Register it** as a handoff destination, under the house company, as the owner
   connection:

   ```sql
   select id, name from organizations where type = 'internal';   -- expect one row
   insert into organization_domains (organization_id, hostname, is_primary, verified_at)
   select id, 'app.10xid.com', false, now() from organizations where type = 'internal';
   ```
3. **Check** that `https://app.10xid.com/` signs you in through `login.10xid.com` and
   lands on the dashboard.
4. **Switch.** Set `PORTAL_HOST=app.10xid.com` on the service answering
   `login.10xid.com`, and redeploy. From then on every portal page asked for there is sent to
   `app.10xid.com`, the sign-in screens on any other host are sent to the login host, and
   staff finish their authenticator step on the login host before being handed over.

Undoing it is unsetting `PORTAL_HOST`. The redirects are 307s, which browsers do not cache.

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
- **A client sees only their own company's jobs.** Staff see every client, and act on one
  at a time through a time-boxed grant carrying a typed reason.
- **Requests arrive as cards** on the dashboard, carrying what the sender actually wrote,
  and each can be given a Google Drive folder with the request filed into it.
- **A client's own systems can file work** with their own API key — write-only, bound to
  one company, revocable without touching anybody's login.

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

Needs Node 22+ and PostgreSQL 16.

```bash
npm install
cp .env.example .env.local        # then fill in the two connection strings

npm run db:migrate                # runs as the OWNER
npm run db:seed                   # two client companies, one internal, three people
npm run dev
```

Two connection strings, and they must differ: `DATABASE_URL` owns the tables and runs
migrations, `DATABASE_APP_URL` is the restricted role the application connects as.

Sign-in codes are not emailed in development — they are appended to
`/tmp/portal-signin-codes.log` and printed to the server log. In production the mailer
**refuses** to fall back to that, rather than writing codes to disk where they might be
read.

### The two domains

Cross-domain sign-in cannot be demonstrated between two subdomains of one domain; that is
ordinary cookie behaviour. Local development uses two separate registrable domains:

```
127.0.0.1  login.portal-a.test      # the only place sign-in happens
127.0.0.1  app.portal-a.test        # the portal pages, when PORTAL_HOST is set
127.0.0.1  rotary.portal-b.test     # a client domain
127.0.0.1  northstar.portal-b.test  # a second client, so isolation has a target
```

## Optional integrations

Each is **inert without configuration** rather than half-working. See `.env.example`.

| | What it needs |
|---|---|
| Email (Resend) | `RESEND_API_KEY`. Without it, development writes codes to a file and production refuses to start the flow. |
| Google Drive | A service account with the `drive.file` scope, and one folder shared with it. The scope reaches only files the portal itself created. |
| Optional alternate workspace engines (Claude, OpenAI) | `ANTHROPIC_API_KEY` for the Claude modes; `OPENAI_API_KEY` plus `OPENAI_MODEL_MULTIMODAL` / `OPENAI_MODEL_REVIEW` for the OpenAI modes. They remain in the repository but are not the stated Chat Boss provider intent. See "The workspace" below. |
| Ollama (prototype) | `ENABLE_PROTOTYPE_ENGINE=true` and `OLLAMA_API_KEY` for Ollama Cloud. One picker entry per model in `OLLAMA_MODELS`, plus Auto. Text only, no tools, house workspace only — unless `OLLAMA_CLOUD_CLIENT_DATA=true`, which gives it the job and repository tools and client workspaces. |
| Ollama (self-hosted) | `OLLAMA_SELF_HOSTED=true`, `OLLAMA_BASE_URL` naming your own server, and `OLLAMA_MODELS`. Context and tools like Claude; replaces the prototype. |

## The workspace

> **Provider intent:** Chat Boss is intended to use **Ollama**. No Ollama model or base URL is
> prescribed here; those are deployment choices. The repository currently also contains Anthropic
> and OpenAI engine modes. Whether those alternatives should remain available inside `/chat` is a
> separate architecture decision, so this clarification does not remove or rewrite them.

`/chat` is where staff land: one client's workspace, with conversations kept per client **and per
person** — two staff on the same client do not read each other's conversations. Postgres enforces
both (0018: `app.org_id` and `app.user_id`), and child rows reference their parent by
(id, client, owner) so nothing can be attached to someone else's conversation.

- **The client** is the session's live staff grant, opened from the workspace with a reason exactly
  as on the Clients page. With no grant, the workspace belongs to the house and holds no client data.
- **Ask** answers from the client's records and cites them as `[JOB ROT-0042]`; **Plan** writes a
  step-by-step plan. Neither changes anything. **Build** is shown, disabled, and refused by a database
  constraint until approval, audit and rollback exist.
- **Engines** are modes (`Claude — Coding`, `Claude — Deep analysis`, `OpenAI — Multimodal`,
  `OpenAI — Review`) mapped to model names in the environment, so an upgrade is a variable change.
  One run goes to one provider; a client can be kept off a mode with an `engine_mode_policies` row.
- **Receipts.** Every record the model was given, every tool it ran and every warning is a row,
  written as it happens, and shown in the right-hand panel — "what did the model see?" is answered
  from the database, not from the answer's text.
- `/review`, `/explain`, `/plan` and `/test` are recorded choices with fixed, visible wording
  (`lib/workspace/commands.ts`), never hidden prompts.

- **Repositories** are read through a GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`), never a
  person's token. A repository is linked to **one client at a time** (0019); a conversation picks one
  linked repository and a branch. Each answer resolves the branch to one commit and reads only that
  commit, through eight read-only tools — `list_repositories`, `list_branches`,
  `list_repository_tree`, `read_repository_file`, `search_repository`, `get_commit_history`,
  `get_changed_files`, `create_patch_preview` — bound on the server to the conversation's repository:
  the model names paths, never a repository. `lib/repo/policy.ts` refuses traversal, secrets
  (`.env`, keys, credential files), `.git/`, binaries, symbolic links and submodules, and caps every
  read, listing and search. Each file read is a receipt naming `path`, lines and commit. A patch
  preview is a diff to read and copy; nothing is ever written to a repository.
- **`@path`** and **`@folder:path`** in a message add that file or folder to the conversation's
  context; context files send their first 120 lines, and the model reads further with its tools.

Attachments (private Backblaze B2 storage) come next.

The browser tests for grounded answers run against a local stand-in for the Anthropic API:

```bash
ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4010 \
GITHUB_APP_ID=1 GITHUB_APP_PRIVATE_KEY="$(openssl genrsa 2048 2>/dev/null)" GITHUB_API_URL=http://127.0.0.1:4011 \
npm run test:e2e
```

The GitHub stand-in (`test/e2e/mock-github.ts`) does not check signatures, so any throwaway RSA key will do.

## Proving it

```bash
npm test          # unit and database tests, as the restricted role, against real Postgres
npm run test:e2e  # browser tests across Chrome and Firefox, normal and fresh profiles
npm run prove     # signs in as a real client and guesses another client's job address
```

`npm run prove` prints a transcript rather than an assertion:

```
── the attempt: another client's job, by its exact real id ───────
  HTTP 404 Not Found
  contains their job title:   false
  bytes of their data leaked: 0

  Same status for a real job and an imaginary one: yes
```

That last line matters. An endpoint that answered differently for a real job than an
imaginary one would confirm which ids exist, and could be walked to enumerate a
competitor's workload.

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

- **Next.js 16 renamed middleware to `proxy.ts`.** It does one cheap thing: send a
  cookie-less request on a client domain into the handoff. It deliberately does not
  validate sessions — that belongs in the data layer.
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
