# PROJECT_STATE

## Current phase
Phase 1 — Platform Hardening

## Current action
Self-hosted sign-in (Better Auth) built on branch `claude/great-ptolemy-sd6k4e` in both repositories, replacing the never-deployed WorkOS integration (app PR #2). Not merged, not deployed; no production variables or DNS changed. Design, variables, provider setup, deployment order and rollback: `docs/better-auth-cutover.md`. Awaiting review, Railway variables (`BETTER_AUTH_SECRET`, `PORTAL_AUTH_PASSWORD`, `AUTH_DATABASE_URL` on login; `PORTAL_HOST`, `PRIMARY_HOST` on app) and optional Google/Microsoft credentials. The legacy emailed-code sign-in and its tests were removed at Paolo's request (2026-10-07); its tables stay.

Previously: WorkOS sign-in foundation (superseded). Phase 1 / Enforced CI/security gates — PR #8 (`ci/database-security`) merged on 2026-10-06.

## Last passed checkpoint
Phase 1 CI enforcement checkpoint: `10xid-com/login` was made public by explicit user choice with no billing change. Classic branch protection rule `84348218` applies to `main` (1 branch), requires a pull request before merging, and requires status check `quality` with updates accepted specifically from GitHub Actions. No database-backed checks or extra review restrictions are required. Approvals are off; administrator bypass remains allowed (`Do not allow bypassing` is unchecked), so do not claim universal/admin enforcement. Force pushes and branch deletions remain disallowed. No production app, DNS, Railway, or Neon changes were made.

## Confirmed findings
- PR #8 live database-security run `37512598512` passed against disposable PostgreSQL 18.6. Guard unit tests passed 30/30; pre-migrate guard passed; all repository migrations applied; restricted `portal_app` post-migrate guard passed; deterministic seed passed; `db:rls-check` passed; Vitest passed 16 files / 263 tests.
- The first live service-identity attempt exposed a representation bug: `inet_server_addr()::text` can differ from Docker's bare IP representation. The guard now compares Docker's exact service IP to `host(inet_server_addr())`, preserving exact-instance matching without accepting private ranges/CIDRs.
- Database-security CI supplies no Ollama, Anthropic, OpenAI, OpenRouter, Railway, Neon, or production credentials. Engine tests use injected fake fetch responses; the Ollama test log messages are simulated provider responses, not live Ollama calls.
- Existing `quality` CI also passed for the live-validation head before this state-only checkpoint update.
- Chat Boss provider intent clarified by the user: **Ollama**, not OpenRouter. No Ollama model or base URL has been selected by this clarification. The repository currently still contains Anthropic and OpenAI engine modes; whether those remain part of Chat Boss is scope-ambiguous and requires a separate architecture decision before code/routing is changed. No OpenRouter dependency or credential is to be added.
- PR #6 Docker topology blocker resolved: `inet_server_addr()` is no longer required to be loopback, because a runner-side localhost port mapping terminates at the PostgreSQL container's Docker-network interface.
- Runner DB URLs remain strictly limited to `localhost`/`127.0.0.1`, port 5432, database `portal_ci`, and expected users. The live server must exactly match `CI_DB_EXPECTED_SERVER_ADDR`; arbitrary private CIDRs/hostnames are not accepted.
- Workflow integration contract is documented: derive exactly one IP from the specific PostgreSQL service container identified by `job.services.postgres.id`; fail on missing container ID, inspect failure, zero addresses, or ambiguous multiple addresses; pass only that exact literal to the guard.
- Driver connection/query errors are now sanitized into fixed guard messages; raw node-postgres errors are not propagated or printed. Deterministic tests explicitly verify credential-bearing fake driver errors do not leak.
- Exact branch files passed `node --check` for guard and test files and `node --test scripts/ci-db-guard.test.mjs` with 30/30 passing tests.
- Existing PR #6 `quality` GitHub Actions run is green after the compatibility fix.
- Local environment has no Docker/Podman/PostgreSQL server available, so a live PostgreSQL 18 service-container execution of the embedded guard SQL remains unverified until the separate workflow-integration PR.
- `scripts/ci-db-guard.mjs` with `pre-migrate` and `post-migrate` modes was merged to `main` in PR #6.
- Guard URL checks require loopback only, database `portal_ci`, owner user `ci_owner`, restricted user `portal_app`, port 5432, disposable passwords, and no URL query parameters/fragments.
- Pre-migrate live checks require direct `ci_owner` authentication to loopback `portal_ci` and a blank user-table target before any migration write.
- Post-migrate live checks require direct `portal_app` authentication, no SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION, no ownership of the CI database or application schemas/relations/routines/enums/domains, and no direct or transitive role memberships.
- Guard unit tests use fake PostgreSQL clients and pass 30/30; live database behavior is now additionally exercised by PR #8 against its disposable PostgreSQL 18.6 service container.
- PR #6 (`ci: add fail-closed database target guard`) was explicitly approved and merged through the protected PR path with required `quality` green and no bypass. Live PostgreSQL 18 execution remained outstanding at merge.
- Database-backed CI design is documented in `docs/ci-database-security-gate-design.md`.
- Proposed CI database is a disposable PostgreSQL 18 GitHub Actions service container on loopback, database `portal_ci`, owner role `ci_owner`, restricted role `portal_app`.
- First DB-backed gate order is: local target guard -> repository migrations via `db:migrate:prod` -> post-migration role/ownership guard -> deterministic `db:seed` -> `db:rls-check` -> `npm test`.
- `scripts/seed.ts` is the correct CI fixture boundary because it truncates migration-authored account/client data and recreates the two-tenant Rotary/Northstar fixture expected by isolation tests.
- `npm run prove` and Playwright E2E are deliberately excluded from the first database gate; they require a separate browser/runtime design.
- Public-repo CI posture for the DB gate: `pull_request` only (never `pull_request_target`), `contents: read`, no production secrets, no Railway/Neon/Vercel credentials, and only disposable local DB passwords.
- CI cleanup relies on destruction of the GitHub Actions service container/job network, not remote DROP/TRUNCATE cleanup.
- CI audit: no `.github/` directory or GitHub Actions workflows exist on `main`.
- Deterministic repo gates already available: `npm run lint`, `npm run typecheck`, `npm run build`; unit/integration Vitest suite is invoked by `npm test`.
- Vitest setup intentionally requires both `DATABASE_URL` (owner fixtures) and `DATABASE_APP_URL` (restricted runtime role), so `npm test` is database-backed rather than a secret-free unit-only gate.
- `npm run db:rls-check` is a build-failing tenant-protection check: all organization-scoped carrier tables must be RLS-protected or explicitly exempted with a documented reason.
- ESLint already enforces a tenancy security rule preventing application code outside `lib/db/` from importing the raw pool or opening direct `pg`/Drizzle node-postgres connections.
- `npm run prove` is a browser-backed live tenant-isolation proof and mutates test state (for example truncating sign-in codes), so it belongs only against an isolated CI database/environment.
- Playwright E2E uses `next dev`, owner DB setup, sign-in-code sink behavior, four browser-context projects, and shared mutable database state; it is unsuitable for a simple first-pass CI job without dedicated ephemeral infrastructure.
- GitHub branch-protection API could not be inspected through the current GitHub App because the integration lacks administration read access (403). Manual UI verification or an admin-capable integration is still required before we can assert branch protection is configured.
- The repository was subsequently made public by explicit user choice, enabling classic branch protection without a billing change. Rule `84348218` now protects `main` for non-bypass paths by requiring a pull request and the GitHub Actions `quality` check. Administrator bypass remains allowed, so protection is not universal.
- The passing CI run produced non-failing GitHub-hosted annotations that `actions/checkout@v4` and `actions/setup-node@v4` currently target the deprecated Node20 action runtime and are being forced to Node24, plus an `ubuntu-latest` migration notice. These are maintenance items, not gate failures.
- Existing `/chat` implementation is the approved Chat Boss foundation.
- Do not introduce a second chat/agent architecture.
- Do not install AI SDK, AI Elements, Redis, object storage, a new auth system, or another database architecture unless specifically approved later.
- Current source database is Railway Postgres and remains the source of truth until a copied Neon database passes full re-certification.
- Railway workspace is on Hobby; native Railway Backups/PITR require Pro.
- Paolo explicitly rejected upgrading Railway to Pro for recoverability.
- Paolo explicitly approved Vercel Pro + Neon as the Phase 1 recoverability path.
- The Railway database was approximately 10 MB (10,843,839 bytes) on 2026-10-02. On 2026-10-07 it is 67,401,407 bytes, including the frozen `research` schema (roughly 50 MB, see below).
- Vercel team is already on Pro.
- Vercel does not provide first-party Postgres; Neon is the approved Marketplace database target.
- The migration must be treated as a database migration, not a hosting switch.
- Railway source must remain untouched during migration and certification.
- No app production variables, DNS, or Railway resources may be changed or deleted before approval/cutover.
- Existing PostgreSQL security model depends on restricted app role `portal_app`, owner separation, grants, RLS policies, and transaction-local tenant context.
- Existing live Railway app role is not superuser, has no BYPASSRLS, and owns zero public tables.
- Existing tenant isolation and workspace isolation tests are substantial and must be rerun against Neon before cutover.
- Current Railway database has no backups/PITR.
- *Superseded by the 2026-10-07 baseline below.* Railway source baseline captured 2026-10-02 from PostgreSQL 18.6, database size 10,843,839 bytes, with 35 public tables, 20 Drizzle migration records, current table row counts, role attributes, ownership, grants, RLS flags, and 27 RLS policies.
- All public tables are currently owned by `postgres`; `portal_app` remains non-superuser and non-BYPASSRLS.
- The 2026-10-02 baseline showed 2 rows in `permissions` (Phase 0 earlier observed 0), so the source dataset changes between checkpoints; the newest baseline (2026-10-07) is authoritative for migration certification.
- Existing GitHub App credential in staging is malformed and remains a later Phase 1 item.
- Current staff account has confirmed TOTP but no recovery codes; current UI can provision them later.
- Current staff base sessions use a 400-day/no-idle policy; review is required later in Phase 1.

## Competitor research engine in the Railway database (added 2026-10-02 by the research-engine work)
- 2026-10-02, about 21:15-21:27 UTC, after the Railway logical dump: a separate Railway service `research-engine` (repo `10xid-com/research-engine`) was added to the project. It created one login, `research_engine` (NOSUPERUSER, NOCREATEDB, NOCREATEROLE), and one schema, `research`, owned by that login, holding 19 tables and 22,562 rows (roughly 50 MB). No `public` object, grant, policy, role or portal variable was changed. `research_engine` can read no table outside `research`. The portal and Postgres services were not redeployed by that work.
- The source baseline and the existing dump predate this and do not include it. Until it is removed, any new dump or verification of the Railway source must exclude schema `research` (`pg_dump --exclude-schema=research`) or account for it. The role `research_engine` is cluster-level and is not in any dump.
- The research engine is out of scope for the portal's Neon migration. Paolo's direction (2026-10-02) is to move its data to a separate database of its own on Neon and then remove schema `research` and role `research_engine` from Railway, restoring the source to its baseline. That removal has not happened yet and needs Paolo's approval.
- Update 2026-10-02 22:16 UTC: the research data was copied to its own database on Neon (project `10xid` in the Neon organisation "Branding", database `research`, login `research_app`; not the portal migration target and not a Vercel Marketplace database) and the `research-engine` service now reads and writes only there. Railway was only read during the copy. Schema `research` and role `research_engine` are still present in the Railway database, frozen and unused, until Paolo removes them (`DROP SCHEMA research CASCADE; DROP ROLE research_engine;` as the database owner). Nothing in the portal depends on them.

## Portal on its own host and repository (added 2026-10-07, live since 2026-10-07 14:06 UTC)
Paolo's direction (2026-10-07): the portal lives at `app.10xid.com` in its own public repository `10xid-com/app`; `login.10xid.com` and this repository keep sign-in, the database schema and the migrations. Done and live:

- **Repositories.** `10xid-com/login` (this one) is sign-in only since PR #14: `/auth/*`, `/auth/sso/authorize`, the schema, migrations, seed and RLS check. `10xid-com/app` (PR app#1, created from this repository's history) is the portal and the receiving end of the handoff. Its `lib/db/schema.ts` is a copy of this one; its `Database` CI fails if the copy differs from this repository's `main` and builds its test database from this repository's migrations and seed. **A schema change lands here first, with its migration, then is copied to `app` unchanged.**
- **Merged here:** #13 (`PORTAL_HOST` switch; sign-in screens only on the login host; full-address redirects across hosts; staff finish the second factor on the login host; act-as handoff fix minting for `ctx.realUserId`; migration `0020`), #15 (`scripts/migrate.mjs` registers `PORTAL_HOST` under the house company on deploy), #14 (portal code removed).
- **Railway, project "10XiD Portal" (production):** service `portal` = `10xid-com/login` `main`, `login.10xid.com`, now with `PORTAL_HOST=app.10xid.com`. New service `app` (id `57a6b03c-868a-4e1c-bc54-ced8bfcd8e6e`) = `10xid-com/app` `main`, serving `app.10xid.com` and `northstar.10xconnections.com` (both verified, certificates valid). `app`'s variables are Railway references to `portal`'s (`DATABASE_APP_URL`, Resend, GitHub App, Ollama) plus `PRIMARY_HOST=login.10xid.com`, `SESSION_COOKIE_SECURE=true`, `PORT=8080`. It has no owner connection and runs no migrations. Its startup check confirmed the restricted role.
- **The old `portal-northstar` service no longer existed** when this work began (its Railway address answered 404 and `northstar.10xconnections.com` was down). Northstar's portal is now served by `app`.
- **Cloudflare DNS (2026-10-07):** zone `10xid.com`: added `app` CNAME `x5oc5lcf.up.railway.app` (DNS-only) and TXT `_railway-verify.app`. Zone `10xconnections.com`: `northstar` CNAME repointed from `2u2c9mtq.up.railway.app` (dead) to `m4ope9vp.up.railway.app` (DNS-only). The proxied wildcard `*.10xid.com` A `185.206.163.79` was left untouched.
- **Database (Railway source):** migration `0020_sessions_source_session` (nullable `sessions.source_session_id`, FK to `sessions`, index) was applied by the PR #13 deploy at 2026-10-07 ~13:52 UTC; the journal now has 21 entries. Paolo approved this as a deliberate exception to "Railway source must remain untouched". `organization_domains` gained `app.10xid.com` under Branding Centres (internal) at 14:05 UTC via the deploy step. The 2026-10-02 baseline is superseded; the 2026-10-07 baseline below includes `0020` and the current `organization_domains` rows. Account for `0020` in the Neon migration-history and schema verification steps.
- **Session behaviour (approved by Paolo 2026-10-07):** a browser's login-host session and the sessions handed over from it are one device; "Sign out here" ends them together and the device count no longer includes your own login session.
- **Verified live after the switch (no real sign-in):** login host sends signed-out visitors to its form and signed-in ones to `app.10xid.com` with the path kept; `/api/*` is not redirected; `app.10xid.com` and northstar start the handoff, which reaches the login host; the portal forwards sign-in screens to the login host; a forged ticket is refused. **A real sign-in end to end was verified by Paolo on 2026-10-07** (signed out, signed in again at `login.10xid.com`, landed on `app.10xid.com` with no second prompt).
- `PORTAL_CLIENT_DOMAINS` on `portal` was reduced to `northstar=northstar.10xconnections.com` (it also re-registered the dead `portal-northstar-production.up.railway.app`). The registration steps only add rows, so the deploy step gained `PORTAL_RETIRED_DOMAINS`: exact hostnames whose rows it deletes, refusing any still configured as live. `portal` has `PORTAL_RETIRED_DOMAINS=portal-northstar-production.up.railway.app`; the deploy log line `Domain retired: …` (or `already retired`) confirms it.

## WorkOS sign-in foundation (built 2026-10-07, NOT deployed)
Built from the 10XiD Build Brief (agreed with the consultant 2026-10-07), Part 1 "Start now" only: the audit, then the WorkOS foundation. Branch `claude/great-ptolemy-sd6k4e` in both repositories; nothing merged, nothing deployed, no Railway, DNS or WorkOS change made.

Paolo's answers to the audit (2026-10-07):
1. Staff access (staff grants, act-as) — **turn off**.
2. Portal on client domains (northstar.10xconnections.com) — **remove**.
3. Existing accounts — bound on first WorkOS sign-in with a verified address, **an operator confirms**.
4. Six role templates; `owner` → owner; **every other action denied** until the permission matrix exists.
5. Database — **Railway** (the existing production database; migration 0021 applies on the next `portal` deploy of `main`).
6. WorkOS setup and the branded login.10xid.com domain — **now**.
7. Extend `organizations` rather than add a `businesses` table.

Here: migration `0021_workos_identity` (additive; safe to apply before the app ships), `scripts/identity-bindings.mjs`, 7-day invitations, `test/workos-binding.test.ts`. In `10xid-com/app`: WorkOS AuthKit via `@workos-inc/authkit-nextjs` 4.4.0, the central authorization function `lib/auth/authorize.ts`, exact-Origin + CSRF on every state-changing request, host-only on `app.10xid.com`, startup refusal of any session setting other than Revision 2's, `/healthz`, and `docs/session-gate.md` (the staging test of instruction 4).

Order to go live: (1) WorkOS environments configured; (2) merge login → `portal` deploy applies 0021; (3) set the app's WorkOS variables and Railway healthcheck path `/healthz`; (4) merge app → `app` deploys; (5) session gate on staging/production; (6) operator confirms existing accounts; (7) remove `northstar.10xconnections.com` from the `app` service and `PORTAL_CLIENT_DOMAINS`, retire its `organization_domains` row; (8) point `login.10xid.com` at WorkOS (DNS-only CNAME) and retire the old sign-in screens.

Still open (the brief's list): permission matrix, check order for agency routes, block rules, switching between businesses, audit-events table, freshness (24 h / 5 min) rules, the browser suite rewritten for WorkOS.

## Railway source baseline — 2026-10-07 (current; supersedes 2026-10-02)
Captured by Codex on Paolo's machine on 2026-10-07 (about 14:30 UTC), after the portal move. Read-only, over the Railway CLI's private SSH tunnel (`railway connect Postgres --tunnel-only`): no public database endpoint was created and the database was not restarted. The catalog queries ran in one repeatable-read, read-only transaction; the dump used a separate snapshot. The tunnel is closed.

- **Dump:** custom-format `pg_dump` from PostgreSQL 18.6 with `--exclude-schema=research`. 186,470 bytes, 422 TOC entries, including the Drizzle journal, public schema and data, ACLs and policies. SHA-256 `02ccef653d404f142b70fe757599a1f9dd8322cce2c15393cb1e3c5afe1bad41`. Validated by archive-manifest inspection and a full `pg_restore --exit-on-error --file=/dev/null` decode; **this is archive validation, not a restore drill** (no restore SQL executed). Kept private on Paolo's machine (`…\Documents\Codex\2026-10-07\you-x20\outputs\railway-source-2026-10-07.dump`); never committed. Cluster roles are not in the dump.
- **Server/database:** PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2); database `railway`; 67,401,407 bytes including the frozen `research` schema (not the portal-only size).
- **Migration journal:** 21 records. IDs 1–21 hash-match `drizzle/0000_smiling_saracen.sql` … `drizzle/0020_sessions_source_session.sql` in this repository exactly. ID 21 (`0020`): `02935e93c7e323069b39420a732607cee775d0933999f3659577af7d6bb7a4c9`.
- **Tables:** 35 in `public`, all owned by `postgres`. RLS enabled on 21, forced on none. Without RLS: `act_as_grants`, `connections`, `identities`, `memberships`, `organization_domains`, `organizations`, `recovery_codes`, `sessions`, `sign_in_codes`, `sso_tickets`, `staff_grants`, `task_time_bands`, `user_emails`, `users`.
- **Policies:** 27 in `public`, all `PERMISSIVE` and all for `portal_app`. They are tenant isolation on `app.org_id`, owner isolation (`app.org_id` and `app.user_id`) on the workspace/agent tables, staff reads on `app.is_staff`, and the `app.authenticating` lookups on `api_keys` and `invitations`.
- **Role `portal_app`:** LOGIN; not SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION; no role memberships; owns no public tables. 110 table-level grants in `public`.
- **`sessions`:** includes `source_session_id uuid` (nullable), index `sessions_source_session_idx`, and FK `sessions_source_session_id_sessions_id_fk` to `sessions(id)`.
- **`organization_domains`:** exactly two rows: `northstar.10xconnections.com` (primary, Northstar) and `app.10xid.com` (not primary, Branding Centres). The stale `portal-northstar-production.up.railway.app` row is absent, confirmed by direct SQL and by deploy `0f5770f3-96a6-4865-8394-2821e04d1152`.
- **Row counts:** act_as_grants 2, agent_run_receipts 42, agent_runs 11, api_keys 0, connections 0, conversation_context_items 2, conversation_messages 20, conversations 7, department_members 0, departments 0, engine_mode_policies 0, identities 0, invitations 0, job_events 4, jobs 3, memberships 10, organization_domains 2, organizations 10, permissions 2, recovery_codes 0, repositories 1, sessions 17, sign_in_codes 20, sso_tickets 3, staff_grants 19, task_claims 0, task_events 0, task_grades 0, task_offers 0, task_time_bands 3, task_types 0, tasks 0, user_emails 9, users 9, workspaces 3.
- The full catalog output (policy expressions, per-table grants, `sessions` and `organization_domains` definitions) is kept with the dump on Paolo's machine rather than in this public repository.

## Restore drill — 2026-10-07 (first run: restore OK, NOT CERTIFIED, re-run needed)
Run by Codex on Paolo's machine from `main` at `9d5efc3`. Railway was read only (through the tunnel), and no Railway data, app variables or DNS were changed. Evidence files are kept locally with the dump.

- **Restore: passed.** Neon project `10xid-staging-neon-migration` (`wandering-rice-63846736`), branch `restore-drill-2026-10-07` (`br-blue-truth-ak9gkh54`, retained), new empty database `restore-drill-2026-10-07` (owner `neondb_owner`). Dump SHA-256 verified first. `pg_restore --no-owner --exit-on-error` (client 18.6) exited 0. `portal_app` existed with LOGIN and none of SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION; its password was reset on the drill branch only.
- **Certification: NOT CERTIFIED (2 failures). Both trace to the method, not to the copy.**
  - **Data.** Compared against the *live* Railway source, which had changed since the dump: `act_as_grants` 3 vs 2, `staff_grants` 21 vs 19, `sessions` touched, and `organization_domains.verified_at` refreshed by later deploys. The copy's counts equal the 2026-10-07 baseline. Two more checksum differences (`drizzle.__drizzle_migrations`, `agent_run_receipts`) were a certifier bug: rows were ordered by the database's collation (Railway `en_US.utf8`, the new Neon database `C.UTF-8`). Codex confirmed both match when ordered `COLLATE "C"`. The copy's journal checksum (`ea122019…`) equals the repository's, computed independently.
  - **Role membership.** Neon grants its owner admin over roles it creates (`neondb_owner` ∈ `portal_app`, granted by `cloud_admin`, admin true, inherit and set false). It cannot be revoked by the owner and gives `portal_app` nothing. The certifier was comparing both directions; only roles granted *to* `portal_app` matter.
  - Everything else passed: journal (21, all LF-matching), columns 332, constraints 411 (with `conversations_branch_sane` differing only in parentheses, reviewed by Codex), indexes 107, functions 12, triggers 12, enums 16, sequences 4, `portal_app` posture, 110 grants, 36 RLS flags, 27 policies, and all three tenant-context checks.
- **Real difference found: collation.** The Neon database was created with `C.UTF-8`; Railway's is `en_US.utf8`. Sorting differs between them, so the next drill creates the database with matching collation (runbook §2). If Neon refuses `en_US.UTF-8`, accepting a different collation is a decision for Paolo.
- **Tests: 174 passed, 22 failed** (`api-keys` 13, `workspace-isolation` 9; NOT NULL on `created_by`), on disposable branch `restore-drill-tests` (`br-damp-snow-akxc4m0t`, since deleted). Cause: the instructions omitted `npm run db:seed`. The tests look up seeded fixture users that a production copy doesn't have, while CI seeds first. Not a database fault.
- **Fixed since** (PR after #19): the certifier orders checksums `COLLATE "C"`, checks the database's encoding and collation, compares only roles granted *to* `portal_app` (and lists members of it), and has a `BASELINE_FILE` drill mode (`docs/baselines/railway-2026-10-07.json`). The runbook now covers matching collation, baseline mode, and seeding before tests. All were re-tested locally.
- **Re-run needed:** a new drill database with matching collation; certify with `BASELINE_FILE`; `npm run db:seed && npm test` on a disposable branch. The retained branch `restore-drill-2026-10-07` can be deleted once the re-run is done. *Done; see the rerun below.*

## Restore drill rerun — 2026-10-07 (restore OK, tests pass, NOT CERTIFIED: locale provider)
Run by Codex on Paolo's machine from `main` at `caadd66` (Node 22.22.3, PostgreSQL client 18.6). Railway was read only, through a tunnel that was closed afterwards. No Railway data, app variables, DNS or code were changed. Full outputs are kept locally with the dump.

- **Restore: passed.** Dump SHA-256 verified first (`02ccef65…`, 186,470 bytes). The target was new branch `restore-drill-2026-10-07-rerun` (`br-aged-fire-akrrt3rm`, retained) and a new empty database of the same name (owner `neondb_owner`). The inherited `neondb` and `railway_restore_test` were dropped on that branch only. `portal_app` was verified with LOGIN and none of SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION. `pg_restore --no-owner --exit-on-error` exited 0.
- **Certification (`BASELINE_FILE` mode): NOT CERTIFIED, 1 failure: database encoding and collation.** Everything else passed:
  - journal (21 triples; all 21 match the repository's LF hashes on both sides);
  - columns 332, constraints 411 (`conversations_branch_sane` again differs only in parentheses; reviewed), indexes 107, functions 12, triggers 12, enums 16, sequences 4;
  - all 36 table counts equal the baseline;
  - `portal_app` posture, no roles granted to it, 110 grants, 36 RLS flags, 27 policies, and all three tenant-context checks.
  - Five tables show live-source drift since the dump (`act_as_grants` 3/2, `sessions` 18/17, `sso_tickets` 4/3, `staff_grants` 21/19, `organization_domains` contents). These are sign-ins and deploys after the dump; the copy matches the dump.
- **The failure is real, and the runbook caused it.** The database was created with `lc_collate 'en_US.UTF-8'` but no `locale_provider`, so it kept `template0`'s builtin provider (`C.UTF-8`), and `lc_collate` does not decide sorting under that provider. Measured: Railway libc `en_US.utf8` (glibc 2.41) sorts `-, 1, a, A, z, Z`; the copy (builtin, `C.UTF-8`) sorts `-, 1, A, Z, a, z`. Neon accepted the `en_US.UTF-8` locale name, so `locale_provider libc` with that locale is expected to work.
- **Tests: 196 passed, 0 failed** (13 files, 120 s), after `npm run db:seed` on disposable branch `restore-drill-tests-rerun` (`br-polished-poetry-ako3g4od`, since deleted). The parent was checked afterwards: all 36 counts still equal the baseline, and it has no seeded users.
- **Cleanup:** the old `restore-drill-2026-10-07` branch was deleted. Neon branches are now `main`, `railway-pitr-drill`, `railway-restore-drill` and `restore-drill-2026-10-07-rerun`. The last is a rehearsal result, not a cutover target, and can be deleted once a certified drill exists.
- **Fixed since:** runbook §2 now creates the database with `locale_provider libc lc_collate 'en_US.utf8' lc_ctype 'en_US.utf8'` and checks provider and sort order before restoring. The certifier now compares a sample sort order as well as the settings, treats `en_US.UTF-8` and `en_US.utf8` as the same name, and prints the collation library versions. Tested locally: a spelling-only difference passes, and an ICU `en-US` database fails on both provider and order.

## Blockers
- Neon target currently contains migration-authored application rows; source data must not be imported on top of them until a safe reset/import sequence is selected.
- *Corrected 2026-10-07:* all 21 Railway migration-journal hashes match the SHA-256 of the repository's current `drizzle/*.sql` files exactly (compared against the 2026-10-07 baseline), so the repository's migration SQL is what Railway applied. Replay is still not a full reconstruction, because migration 0012 writes data (see below) and data comes from the dump.
- A source-authoritative custom-format pg_dump was created from Railway on 2026-10-02 (PostgreSQL 18.6, 420 TOC entries). *Superseded by the 2026-10-07 dump below, which is the one to restore from.*
- pg_dump does not include cluster roles themselves; `portal_app` must exist separately on the Neon target before restoring ACLs/policies that reference it.
- Source object ownership is recorded as `postgres`; on Neon we should restore with ownership suppressed and keep object ownership under the Neon owner while preserving the restricted non-owner `portal_app` separation.
- Railway has no native backup or PITR for this database (Hobby plan). Logical dumps exist only off-platform, on Paolo's machine (2026-10-02, 2026-10-07).
- Neon target role/ownership model has been partially inspected. `neondb_owner` is non-superuser but has BYPASSRLS and CREATEROLE; database owner is `neondb_owner`; `public` schema owner is `pg_database_owner`.
- Neon successfully created a transactional test login role matching the intended app-role attributes: NOSUPERUSER, NOBYPASSRLS, LOGIN, NOCREATEDB, NOCREATEROLE. The transaction rollback removed the role, confirming no persistent change.
- `neondb_owner` does not automatically have SET ROLE permission to a role it creates. An explicit membership grant is required for SQL-editor impersonation tests; this is a test-harness detail, not an app-runtime requirement because the app will connect directly as the restricted role.
- Neon successfully preserved transaction-local custom settings `app.org_id`, `app.user_id`, and `app.is_staff` while running as a restricted role. After rollback, the settings were empty and the temporary role no longer existed.
- Neon successfully enforced an RLS policy bound to `app.org_id` under a restricted app-like role: one same-tenant row visible, cross-tenant row count zero; rollback removed all test objects.
- Applying repository migrations to an empty Neon database is not schema-only. Migration 0012 contains committed application data and creates up to 8 organizations, 8 users, and 8 memberships; later migrations audit/reconcile some of that data. Therefore a naïve source data import onto the migrated target risks uniqueness/PK conflicts and must not proceed until target state is baselined and the copy method is adjusted.
- Neon post-migration counts include organizations=8, users=8, user_emails=8, memberships=8, permissions=1, task_time_bands=3, while most other tables are empty.
- The Neon migration journal contains 20 entries, but its hashes differ from the Railway source journal for many IDs (IDs 1-3 and 5-20). *Corrected 2026-10-07:* this does not mean the repository's migration files changed, since Railway's hashes match the current files exactly. The pattern matches line endings instead: converting the files to CRLF changes the hash of every one except ID 4 (`0003_job_counter`), exactly the IDs that differ. Most likely Neon was migrated from a checkout with CRLF line endings (e.g. Windows with `core.autocrlf=true`). The SQL executed is the same; the journal hashes are not. Confirm by comparing Neon's hashes with the CRLF hashes, and migrate Neon from an LF checkout (`git config core.autocrlf false`, or a `.gitattributes` with `*.sql text eol=lf`).
- *Corrected 2026-10-07:* a restore rehearsal of the 2026-10-02 dump into Neon and a Neon point-in-time recovery drill were performed and are recorded in `docs/recoverability-runbook.md` (all 35 table counts, all 20 journal triples, grants, RLS flags, policies and tenant isolation matched). The 2026-10-07 dump was restored on 2026-10-07; see "Restore drill — 2026-10-07".
- Neon role/ownership/grant/RLS compatibility has not yet been re-certified.

## Architecture decisions awaiting Paolo
- None for the database platform choice: Paolo approved Vercel Pro + Neon.
- Any change to RLS behaviour such as FORCE ROW LEVEL SECURITY still requires a later recommendation and approval.
- Any production/staging environment creation or cutover plan still requires approval before resource changes.
- Any session-policy change still requires approval.

## Migration acceptance criteria before any cutover
The copied Neon database must pass:
1. restore/recovery demonstration on a separate branch/database,
2. migration-history verification,
3. schema verification,
4. source-vs-target row-count verification,
5. role/ownership/grant verification,
6. RLS and policy verification,
7. transaction-local tenant-context verification,
8. application/database isolation tests.

## Next action
- Certify the restore (see "Restore drill rerun — 2026-10-07"). Create a new Neon database with `locale_provider libc` and `en_US.utf8` (runbook §2) and confirm the provider and sort order before restoring. Then restore the 2026-10-07 dump and certify with `BASELINE_FILE=docs/baselines/railway-2026-10-07.json`. Tests already pass on this dump, so rerun them only if the restore differs. If Neon refuses libc `en_US.utf8`, accepting another collation is a decision for Paolo. Delete `restore-drill-2026-10-07-rerun` afterwards.
- Decide whether `database-security` becomes a required check in branch protection (PR #8 is merged; the protection setting is unverified).
