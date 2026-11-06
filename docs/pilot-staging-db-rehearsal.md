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

Not done: synthetic users/CiD fixtures. `npm run db:seed` writes fixed `.test` hosts/emails
and is not loopback-guarded, so it was left out; add a dedicated synthetic seed later.
`scripts/ci-db-guard.mjs` (loopback-only) is intentionally unchanged.
