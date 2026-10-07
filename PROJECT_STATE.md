# PROJECT_STATE

## Current phase
Phase 1 — Platform Hardening

## Current action
Phase 1 / Enforced CI/security gates — PR #8 (`ci/database-security`) now has a live disposable PostgreSQL 18.6 database-security run passing end-to-end. Existing `quality` remains intact. PR #8 is open/unmerged and the new database-security check has not been added to branch protection.

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
- The current Railway database is approximately 10 MB (10,843,839 bytes).
- Vercel team is already on Pro.
- Vercel does not provide first-party Postgres; Neon is the approved Marketplace database target.
- The migration must be treated as a database migration, not a hosting switch.
- Railway source must remain untouched during migration and certification.
- No app production variables, DNS, or Railway resources may be changed or deleted before approval/cutover.
- Existing PostgreSQL security model depends on restricted app role `portal_app`, owner separation, grants, RLS policies, and transaction-local tenant context.
- Existing live Railway app role is not superuser, has no BYPASSRLS, and owns zero public tables.
- Existing tenant isolation and workspace isolation tests are substantial and must be rerun against Neon before cutover.
- Current Railway database has no backups/PITR.
- Railway source baseline captured from PostgreSQL 18.6, database size 10,843,839 bytes, with 35 public tables, 20 Drizzle migration records, current table row counts, role attributes, ownership, grants, RLS flags, and 27 RLS policies.
- All public tables are currently owned by `postgres`; `portal_app` remains non-superuser and non-BYPASSRLS.
- Current baseline shows 2 rows in `permissions` (Phase 0 earlier observed 0), so the source dataset changed between checkpoints; the new baseline is authoritative for migration certification.
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
- **Database (Railway source):** migration `0020_sessions_source_session` (nullable `sessions.source_session_id`, FK to `sessions`, index) was applied by the PR #13 deploy at 2026-10-07 ~13:52 UTC; the journal now has 21 entries. Paolo approved this as a deliberate exception to "Railway source must remain untouched". `organization_domains` gained `app.10xid.com` under Branding Centres (internal) at 14:05 UTC via the deploy step. **The Railway source baseline captured on 2026-10-02 (20 migration records) is stale**: re-capture the migration journal, schema, `sessions` definition and `organization_domains` rows from Railway, and account for `0020` in the Neon migration-history and schema verification steps.
- **Session behaviour (approved by Paolo 2026-10-07):** a browser's login-host session and the sessions handed over from it are one device; "Sign out here" ends them together and the device count no longer includes your own login session.
- **Verified live after the switch (no real sign-in):** login host sends signed-out visitors to its form and signed-in ones to `app.10xid.com` with the path kept; `/api/*` is not redirected; `app.10xid.com` and northstar start the handoff, which reaches the login host; the portal forwards sign-in screens to the login host; a forged ticket is refused. **A real sign-in end to end was verified by Paolo on 2026-10-07** (signed out, signed in again at `login.10xid.com`, landed on `app.10xid.com` with no second prompt).
- `PORTAL_CLIENT_DOMAINS` on `portal` was reduced to `northstar=northstar.10xconnections.com` (it also re-registered the dead `portal-northstar-production.up.railway.app`). The registration steps only add rows, so the deploy step gained `PORTAL_RETIRED_DOMAINS`: exact hostnames whose rows it deletes, refusing any still configured as live. `portal` has `PORTAL_RETIRED_DOMAINS=portal-northstar-production.up.railway.app`; the deploy log line `Domain retired: …` (or `already retired`) confirms it.

## Blockers
- Neon target currently contains migration-authored application rows; source data must not be imported on top of them until a safe reset/import sequence is selected.
- Current repo migration hashes do not match the Railway source migration journal, so migration replay is not a source-faithful reconstruction method.
- A source-authoritative custom-format pg_dump was created from Railway on 2026-10-02. The archive reports PostgreSQL 18.6 source/dumper versions, 420 TOC entries, and includes the Drizzle migration journal plus public data and security objects.
- pg_dump does not include cluster roles themselves; `portal_app` must exist separately on the Neon target before restoring ACLs/policies that reference it.
- Source object ownership is recorded as `postgres`; on Neon we should restore with ownership suppressed and keep object ownership under the Neon owner while preserving the restricted non-owner `portal_app` separation.
- No source database backup exists today.
- Neon target role/ownership model has been partially inspected. `neondb_owner` is non-superuser but has BYPASSRLS and CREATEROLE; database owner is `neondb_owner`; `public` schema owner is `pg_database_owner`.
- Neon successfully created a transactional test login role matching the intended app-role attributes: NOSUPERUSER, NOBYPASSRLS, LOGIN, NOCREATEDB, NOCREATEROLE. The transaction rollback removed the role, confirming no persistent change.
- `neondb_owner` does not automatically have SET ROLE permission to a role it creates. An explicit membership grant is required for SQL-editor impersonation tests; this is a test-harness detail, not an app-runtime requirement because the app will connect directly as the restricted role.
- Neon successfully preserved transaction-local custom settings `app.org_id`, `app.user_id`, and `app.is_staff` while running as a restricted role. After rollback, the settings were empty and the temporary role no longer existed.
- Neon successfully enforced an RLS policy bound to `app.org_id` under a restricted app-like role: one same-tenant row visible, cross-tenant row count zero; rollback removed all test objects.
- Applying repository migrations to an empty Neon database is not schema-only. Migration 0012 contains committed application data and creates up to 8 organizations, 8 users, and 8 memberships; later migrations audit/reconcile some of that data. Therefore a naïve source data import onto the migrated target risks uniqueness/PK conflicts and must not proceed until target state is baselined and the copy method is adjusted.
- Neon post-migration counts include organizations=8, users=8, user_emails=8, memberships=8, permissions=1, task_time_bands=3, while most other tables are empty.
- The Neon migration journal contains 20 entries, but its hashes differ from the Railway source journal for many IDs (for example IDs 1-3 and 5-20). This proves the repository migration files have changed since the Railway database originally applied them. Replaying current migrations cannot be used to reconstruct the Railway source exactly.
- No migration copy or restore drill has yet been performed.
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
Human-review PR #8 and its live PostgreSQL 18 results. Do not merge PR #8 or add `database-security` to branch protection until explicitly approved.
