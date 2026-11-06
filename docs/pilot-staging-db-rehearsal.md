# Pilot staging DB rehearsal (staging only)

One-shot runner: `npm run pilot:db-rehearsal` (`node scripts/pilot-staging-db-rehearsal.mjs`),
run inside the private Railway `pilot-staging` environment
(`fa3e9119-a1f0-4a1e-a789-76e40fda7f68`). Never run it against production.

Required variables: `RAILWAY_ENVIRONMENT_ID`, `PILOT_DB_REHEARSAL_TEST_ONLY=I_UNDERSTAND_THIS_IS_TEST_ONLY`,
`PILOT_EXPECTED_DB_HOST` (`<service>.railway.internal`), `DATABASE_URL`
(`ci_owner` @ that host, port 5432, db `portal_ci`, no query), `PILOT_APP_PASSWORD`,
`PILOT_AUTH_PASSWORD` (distinct fresh hex, 32+ chars).
Forbidden (runner refuses if set): `BOOTSTRAP_*`, `PORTAL_*`, `DATABASE_APP_URL`,
`AUTH_DATABASE_URL`, `DATABASE_PUBLIC_URL`, mail provider keys, production markers.

All gates run before any connection. Then: `npm run db:migrate:prod`, `ALTER ROLE ... LOGIN`
for `portal_app`/`portal_auth` (passwords via `format(%L)`), and checks for Drizzle through 0065,
role attributes, no dangerous grants, RLS, function EXECUTE boundaries and a login per role.
Success prints `PILOT_DB_REHEARSAL_OK`; exit code is non-zero otherwise. Secrets are never printed.

`npm run db:seed` writes fixed `.test` hosts/emails and is not loopback-guarded, so it is not used.
`scripts/ci-db-guard.mjs` (loopback-only) is intentionally unchanged.

## Optional synthetic sign-in fixture (separate one-shot)

Run only after the runner has passed: `npm run pilot:fixtures-seed`
(`scripts/pilot-staging-fixtures.mjs`). It uses the same target guard (environment ID,
exact private host, `ci_owner`, `portal_ci`) with its own flag `PILOT_FIXTURES_TEST_ONLY`
set to `I_UNDERSTAND_THIS_IS_TEST_ONLY`. It refuses if the runner's flag or role passwords
are set, and refuses if any non-`@rehearsal.invalid` sign-in identity already exists.

Before inserting, in the same transaction, it anonymizes the eight contacts the migrations seed
(matched by SHA-256 of the address, no sign-in identity): soft-deleted, renamed to
`legacy-<hash8>@rehearsal.invalid`, memberships removed, and their addresses scrubbed from
`user_emails`, `audit_events.target` and the seeded public-profile `email`. It refuses (no changes)
if any other non-synthetic user exists, a contact has an identity/credential, or a session, key,
invitation or sign-in link references one. Counts only are printed; a re-run changes nothing.

Inputs (names only, values never printed): `PILOT_FIXTURE_PASSWORD` (12-128 chars),
`PILOT_FIXTURE_TOTP_SECRET` (20-64 letters/digits; the raw secret the app stores, shown to
authenticator apps in base32), `BETTER_AUTH_SECRET` (must equal the pilot login service's
value, otherwise the stored authenticator cannot be decrypted). No mail transport is used.

Creates, idempotently with fixed ids: organizations `pilot-branding`, `pilot-vinyl`, and four
verified, invite-style accounts with a Better Auth scrypt password and a confirmed authenticator:
`pilot.manager@` owner and `pilot.member@` editor in pilot-branding; `pilot.alternate@` manager
and `pilot.outside@` member in pilot-vinyl (all `@rehearsal.invalid`). No backup codes are issued.
