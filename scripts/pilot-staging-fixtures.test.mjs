import test from "node:test";
import assert from "node:assert/strict";
import { checkSeedGates, PEOPLE, ORGS } from "./pilot-staging-fixtures.mjs";
import { EXPECTED, checkGates } from "./pilot-staging-db-rehearsal.mjs";

const HOST = "pilot-postgres.railway.internal";
const good = () => ({
  RAILWAY_ENVIRONMENT_ID: EXPECTED.railwayEnvironmentId,
  PILOT_FIXTURES_TEST_ONLY: EXPECTED.testOnlyFlag,
  PILOT_EXPECTED_DB_HOST: HOST,
  DATABASE_URL: `postgresql://ci_owner:ownerpw@${HOST}:5432/portal_ci`,
  PILOT_FIXTURE_PASSWORD: "synthetic-Passw0rd-xyz",
  PILOT_FIXTURE_TOTP_SECRET: "A".repeat(32),
  BETTER_AUTH_SECRET: "s".repeat(40),
});
const refuses = (mut, re) =>
  test(`seed refuses: ${re}`, () => {
    const e = good();
    mut(e);
    assert.throws(() => checkSeedGates(e), re);
  });

test("seed accepts the exact staging contract", () => {
  const r = checkSeedGates(good());
  assert.equal(r.target.host, HOST);
});
test("fixture roster is the four approved accounts", () => {
  assert.deepEqual(
    PEOPLE.map((p) => [p.email, p.org, p.role]),
    [
      ["pilot.manager@rehearsal.invalid", "pilot-branding", "owner"],
      ["pilot.member@rehearsal.invalid", "pilot-branding", "editor"],
      ["pilot.alternate@rehearsal.invalid", "pilot-vinyl", "manager"],
      ["pilot.outside@rehearsal.invalid", "pilot-vinyl", "member"],
    ],
  );
  assert.deepEqual(ORGS.map((o) => o.slug), ["pilot-branding", "pilot-vinyl"]);
});
test("runner still forbids BETTER_AUTH_SECRET (allow-list is seed-only)", () => {
  const e = {
    RAILWAY_ENVIRONMENT_ID: EXPECTED.railwayEnvironmentId,
    PILOT_DB_REHEARSAL_TEST_ONLY: EXPECTED.testOnlyFlag,
    PILOT_EXPECTED_DB_HOST: HOST,
    DATABASE_URL: `postgresql://ci_owner:ownerpw@${HOST}:5432/portal_ci`,
    PILOT_APP_PASSWORD: "a".repeat(48),
    PILOT_AUTH_PASSWORD: "b".repeat(48),
    BETTER_AUTH_SECRET: "s".repeat(40),
  };
  assert.throws(() => checkGates(e), /BETTER_AUTH_SECRET/);
});
refuses((e) => delete e.PILOT_FIXTURES_TEST_ONLY, /test-only/);
refuses((e) => (e.PILOT_FIXTURES_TEST_ONLY = "yes"), /test-only/);
refuses((e) => (e.PILOT_DB_REHEARSAL_TEST_ONLY = EXPECTED.testOnlyFlag), /PILOT_DB_REHEARSAL_TEST_ONLY/);
refuses((e) => (e.RAILWAY_ENVIRONMENT_ID = "x"), /ENVIRONMENT_ID/);
refuses((e) => (e.RAILWAY_ENVIRONMENT_NAME = "production"), /pilot-staging/);
refuses((e) => (e.PILOT_EXPECTED_DB_HOST = "localhost"), /railway\.internal/);
refuses((e) => (e.DATABASE_URL = e.DATABASE_URL.replace(HOST, "other.railway.internal")), /host/);
refuses((e) => (e.DATABASE_URL = e.DATABASE_URL.replace("portal_ci", "postgres")), /database/);
refuses((e) => (e.DATABASE_URL = e.DATABASE_URL.replace("ci_owner", "portal_app")), /user/);
refuses((e) => (e.DATABASE_URL += "?sslmode=disable"), /query/);
refuses((e) => (e.DATABASE_APP_URL = "postgresql://x"), /DATABASE_APP_URL/);
refuses((e) => (e.DATABASE_PUBLIC_URL = "postgresql://x"), /DATABASE_PUBLIC_URL/);
refuses((e) => (e.RESEND_API_KEY = "k"), /RESEND_API_KEY/);
refuses((e) => (e.SMTP_HOST = "h"), /SMTP_HOST/);
refuses((e) => (e.PORTAL_HOST = "h"), /PORTAL_HOST/);
refuses((e) => (e.BOOTSTRAP_EMAIL = "a@b.c"), /BOOTSTRAP_EMAIL/);
refuses((e) => (e.NODE_ENV = "production"), /production/);
refuses((e) => (e.PILOT_APP_PASSWORD = "a".repeat(40)), /PILOT_APP_PASSWORD/);
refuses((e) => delete e.PILOT_FIXTURE_PASSWORD, /PASSWORD/);
refuses((e) => (e.PILOT_FIXTURE_PASSWORD = "short"), /PASSWORD/);
refuses((e) => delete e.PILOT_FIXTURE_TOTP_SECRET, /TOTP/);
refuses((e) => (e.PILOT_FIXTURE_TOTP_SECRET = "bad secret!"), /TOTP/);
refuses((e) => delete e.BETTER_AUTH_SECRET, /BETTER_AUTH_SECRET/);
refuses((e) => (e.BETTER_AUTH_SECRET = "short"), /BETTER_AUTH_SECRET/);
refuses((e) => (e.PILOT_FIXTURE_PASSWORD = "ownerpw-ownerpw-ownerpw".slice(0, 12) && "ownerpw"), /PASSWORD/);
