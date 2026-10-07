# Recoverability Runbook: Railway PostgreSQL -> Neon

Status: validated rehearsal procedure. Production cutover has **not** occurred.

## Purpose

This runbook records the source-authoritative recovery path validated during Phase 1. The Railway PostgreSQL database remains the source of truth until an explicit cutover is approved. Do not change production application variables, DNS, or delete Railway resources as part of this procedure.

## Architecture decision

The approved recoverability architecture is Railway PostgreSQL -> Neon PostgreSQL.

Important constraints:

- Treat the live Railway database as authoritative for schema, data, functions, triggers, policies, grants, and Drizzle migration history.
- Do not reconstruct the database by replaying the current repository migrations: some historical migrations contain data writes, and the data has to come from the dump. (An earlier version of this line also said the committed migration files no longer match Railway's journal. That is not so: on 2026-10-07 all 21 Railway journal hashes matched the repository's files exactly. A journal whose hashes differ is the sign of migrations applied from a checkout with CRLF line endings; `scripts/certify-copy.mjs` reports which.)
- Restore into a separate Neon database or branch first.
- Keep the runtime application role separate from object ownership.
- Do not enable FORCE RLS automatically; that remains a separate reviewed decision.

## 1. Create the Railway source dump

The database has no public endpoint. Reach it through the Railway CLI's private SSH tunnel, which needs no TCP proxy and no restart:

```bash
railway link                                         # project "10XiD Portal", environment production
railway connect Postgres --tunnel-only --port 54329  # leave running; prints the connection details
```

Then, in a second terminal, with `DATABASE_URL` set privately to the tunnelled owner connection (never paste database URLs into chat, tickets, or documentation). Use a `pg_dump` whose major version matches the server (18), and leave out the frozen `research` schema while it still exists:

```bash
set -e
DUMP=/tmp/10xid-railway-source.dump

pg_dump "$DATABASE_URL" \
  --format=custom \
  --exclude-schema=research \
  --no-password \
  --verbose \
  --file="$DUMP"

ls -lh "$DUMP"
pg_restore --list "$DUMP" | sed -n '1,120p'
```

The custom-format dump is expected to contain:

- `drizzle.__drizzle_migrations`
- public schema tables and data
- functions and triggers
- indexes and constraints
- ACLs/grants
- RLS policies and metadata

PostgreSQL logical dumps do **not** recreate cluster roles. Required roles must exist on the target separately.

## 2. Prepare an isolated Neon target

Create a separate empty database **with the same encoding and collation as the source**. Railway's is `UTF8` with `en_US.utf8` collation and ctype (2026-10-07); a database created with Neon's defaults gets `C.UTF-8`, which sorts text differently, so the copy would behave differently even with identical rows. For example:

```sql
create database railway_restore_test
  template template0 encoding 'UTF8' lc_collate 'en_US.UTF-8' lc_ctype 'en_US.UTF-8';
```

If the platform refuses that locale, stop and decide explicitly, not by default. Accepting a different collation changes the app's sort order, and is a decision for the owner. The certifier's "database encoding and collation" check reports exactly what the copy got.

Before restore, verify the persistent application role:

```sql
select
  rolname,
  rolsuper,
  rolbypassrls,
  rolcanlogin,
  rolcreatedb,
  rolcreaterole
from pg_roles
where rolname = 'portal_app';
```

Required posture:

```text
portal_app | false | false | true | false | false
```

The application role must remain a restricted non-owner and must not have `BYPASSRLS`.

## 3. Restore the source-authoritative dump

Use the Neon owner/direct connection privately. Do not expose it in logs or chat.

```bash
read -s -p "Neon restore target owner URL: " NEON_RESTORE_URL
echo

pg_restore \
  --dbname="$NEON_RESTORE_URL" \
  --no-owner \
  --exit-on-error \
  --verbose \
  /tmp/10xid-railway-source.dump
```

Do not use `--clean` for the certified restore procedure.

### Why `--no-owner` is intentional

Railway objects are owned by Railway's `postgres` role. Neon uses its managed owner role, currently `neondb_owner`. Preserving the literal Railway owner is neither required nor desirable.

With `--no-owner`:

- restored objects become owned by the Neon owner
- `portal_app` remains non-owner
- source ACLs and policies can still be restored
- the critical security invariant is preserved: the runtime application role is restricted and subject to RLS

## 4. Validate source fidelity

Validation must be read-only.

### Automated: `scripts/certify-copy.mjs` (sections 4–6 in one run)

Compares the copy with its source, read-only on both, against acceptance criteria 2–7:

- the migration journal, and both journals against this repository's files (LF and CRLF hashes)
- the database's encoding and collation, then the schema: columns, constraints, indexes, functions, triggers, enums and sequences
- the data: exact row counts and a checksum of every row, per table (rows ordered bytewise, `COLLATE "C"`, so the checksum does not depend on the database's collation)
- `portal_app`'s attributes, the roles granted *to* it, and that it owns nothing
- every table grant to `portal_app`
- the RLS flags and every policy
- on the copy, as `portal_app`: no rows without a tenant, exactly one tenant's rows with one, and no setting left behind

It exits non-zero on any mismatch.

```bash
# Owner connections to the source (via the tunnel) and to the restored copy, and
# portal_app's connection to the copy. Set them privately, e.g. with `read -s`.
SOURCE_URL=... TARGET_URL=... TARGET_APP_URL=... node scripts/certify-copy.mjs
```

**Drill or cutover.** The data comparison only means something against a source that has not changed since the dump.

- **At cutover,** with writes stopped, compare against the live source; that is the default and the strict check.
- **In a drill,** the source is still live. It changes within minutes: sessions are touched, grants are made, and every deploy refreshes `organization_domains.verified_at`. So add the row counts recorded when the dump was taken:

```bash
BASELINE_FILE=docs/baselines/railway-2026-10-07.json SOURCE_URL=... TARGET_URL=... TARGET_APP_URL=... npm run db:certify-copy
```

The copy's counts must then equal the baseline. Anything that changed on the live source since the dump is listed as `drift`, not failed. Schema, journal, roles, grants, RLS and tenant context are still compared against the live source.

Things it reports without failing:

- **Roles that are members *of* `portal_app`.** Neon grants its owner (`neondb_owner`, granted by `cloud_admin`) admin over every role it creates, with `inherit` and `set` false. That lets the owner manage the role's membership, but gives `portal_app` nothing and does not let the owner act as it. Roles granted *to* `portal_app` are what could widen it, and those must match.

- **Table owners** differ by design, because of `--no-owner`.
- **A CHECK constraint whose text differs only in parentheses** is printed as `warn`, with both definitions, for a person to confirm. A restore re-parses the definition and Postgres flattens nested `AND`s, so `((a AND b) AND c)` comes back as `(a AND b AND c)`. In a local drill on 2026-10-07 this happened to `conversations_branch_sane` and nothing else.

The result line is `CERTIFIED`, `CERTIFIED, WITH ITEMS TO REVIEW`, or `NOT CERTIFIED`. In the same drill, deleting one row, dropping one policy, revoking one grant and adding one constraint on the copy each produced a failure.

The manual checks below remain the reference for what each section means.

### Public table counts

Compare all public table counts against the saved Railway source baseline (the current one is in `PROJECT_STATE.md`, "Railway source baseline — 2026-10-07"). The validated rehearsal matched all 35 public tables exactly.

### Drizzle migration journal

Compare:

```sql
select id, hash, created_at
from drizzle.__drizzle_migrations
order by id;
```

The validated rehearsal (2026-10-02 dump) matched all 20 `id/hash/created_at` triples exactly. From the 2026-10-07 dump onwards there are 21, including `0020_sessions_source_session`.

## 5. Validate security structure

Check:

- ownership of all public tables
- `portal_app` role attributes
- RLS enablement and FORCE flags
- all `portal_app` table grants
- every RLS policy, including table, policy name, roles, command, `qual`, and `with_check`

Validated rehearsal result:

- all 35 public tables owned by `neondb_owner` on Neon, intentionally
- all 35 RLS/FORCE flags matched Railway exactly
- `portal_app` remained LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE
- all 110 `portal_app` table privilege triples matched exactly
- all 27 policies matched exactly

## 6. Validate tenant isolation

### Criterion 8: the isolation test suite

Run `npm test` only on a **disposable branch** of the restored copy, never on the copy being certified or on Railway. The suite truncates and writes fixtures. It also needs its fixtures: the tests look up the seeded people (`paolo@brandingcentres.test`, `jane@rotary.test`, `sam@northstar.test`). A restored production copy doesn't have them, so seed the branch first, exactly as CI does:

```bash
# DATABASE_URL / DATABASE_APP_URL: the disposable branch's owner and portal_app connections
npm run db:seed && npm test
```

Without the seed, `test/api-keys.test.ts` and `test/workspace-isolation.test.ts` fail with NOT NULL violations on `created_by`, because the fixture ids come back null. That is a missing seed, not a database fault. It is what the 2026-10-07 drill hit.

Use a transaction that temporarily permits the Neon owner to `SET ROLE portal_app`, then roll the entire transaction back.

Required assertions from the validated drill:

```text
unscoped_jobs = 0
own_tenant_jobs > 0
cross_tenant_jobs = 0
own_conversation_visible = 1
wrong_user_conversation_visible = 0
```

The validated rehearsal produced:

```text
unscoped_jobs = 0
own_tenant_jobs = 2
cross_tenant_jobs = 0
own_conversation_visible = 1
wrong_user_conversation_visible = 0
```

No persistent role-membership or data changes should remain after rollback.

## 7. Recovery drill

A branch created from current HEAD is useful for clone verification, but it is **not** sufficient to prove point-in-time recovery.

For the Phase 1 exit test, use Neon's historical branch creation path:

1. Create a **new branch** from the protected/certified source branch.
2. Choose **branch data and schema from a past point in time**, within the available history-retention window.
3. Do not use an in-place restore that replaces the source branch.
4. On the recovered branch, validate the restored database again:
   - all 35 public table counts
   - all 20 Drizzle migration journal triples

Validated PITR drill:

- branch: `railway-pitr-drill`
- historical timestamp: `2026-10-06T16:07:00Z`
- all 35 public table counts matched
- all 20 migration `id/hash/created_at` triples matched
- source branch, previous certified copies, Railway, app variables, and DNS remained unchanged

At the time of this rehearsal, the Neon Free plan exposed a 6-hour history window. Production retention tier remains a separate architecture/cost decision.

## 8. Cutover guardrails

This runbook does **not** authorize production cutover.

Before any cutover:

- obtain explicit approval for the production resource change
- re-run source-fidelity and security checks on the final target
- confirm the production recovery-retention tier
- configure production application credentials privately
- verify app runtime connects as the restricted non-owner role
- run isolation tests against the final target
- plan rollback before changing application variables or DNS
- keep Railway intact until the new production database is accepted

## Phase 1 recoverability result

The recoverability objective is technically demonstrated:

1. source-authoritative Railway logical backup created
2. restore completed into an isolated Neon database
3. row counts and migration history matched exactly
4. grants, RLS flags, policies, and restricted role posture matched
5. live tenant isolation behavior passed
6. a separate historical Neon point-in-time recovery branch reproduced the certified state

Production cutover remains pending and requires separate approval.
