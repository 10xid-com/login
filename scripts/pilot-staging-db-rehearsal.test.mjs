import test from "node:test";
import assert from "node:assert/strict";
import { checkGates, EXPECTED } from "./pilot-staging-db-rehearsal.mjs";

const HOST = "pilot-postgres.railway.internal";
const good = () => ({
  RAILWAY_ENVIRONMENT_ID: EXPECTED.railwayEnvironmentId,
  PILOT_DB_REHEARSAL_TEST_ONLY: EXPECTED.testOnlyFlag,
  PILOT_EXPECTED_DB_HOST: HOST,
  DATABASE_URL: `postgresql://ci_owner:ownerpw@${HOST}:5432/portal_ci`,
  PILOT_APP_PASSWORD: "a".repeat(48),
  PILOT_AUTH_PASSWORD: "b".repeat(48),
});
const refuses = (mut, re) =>
  test(`refuses: ${re}`, () => {
    const e = good();
    mut(e);
    assert.throws(() => checkGates(e), re);
  });

test("accepts the exact staging contract", () => {
  assert.deepEqual(checkGates(good()), { host: HOST, port: "5432", database: "portal_ci" });
});
refuses((e) => (e.RAILWAY_ENVIRONMENT_ID = "x"), /ENVIRONMENT_ID/);
refuses((e) => delete e.RAILWAY_ENVIRONMENT_ID, /ENVIRONMENT_ID/);
refuses((e) => (e.RAILWAY_ENVIRONMENT_NAME = "production"), /pilot-staging/);
refuses((e) => delete e.PILOT_DB_REHEARSAL_TEST_ONLY, /test-only/);
refuses((e) => (e.PILOT_EXPECTED_DB_HOST = "localhost"), /railway\.internal/);
refuses((e) => (e.DATABASE_URL = e.DATABASE_URL.replace(HOST, "other.railway.internal")), /host/);
refuses((e) => (e.DATABASE_URL = e.DATABASE_URL.replace("portal_ci", "postgres")), /database/);
refuses((e) => (e.DATABASE_URL = e.DATABASE_URL.replace("ci_owner", "postgres")), /user/);
refuses((e) => (e.DATABASE_URL += "?sslmode=disable"), /query/);
refuses((e) => (e.DATABASE_URL = e.DATABASE_URL.replace(":5432", ":5433")), /port/);
refuses((e) => (e.BOOTSTRAP_EMAIL = "a@b.c"), /BOOTSTRAP_EMAIL/);
refuses((e) => (e.PORTAL_APP_PASSWORD = "x"), /PORTAL_APP_PASSWORD/);
refuses((e) => (e.DATABASE_APP_URL = "postgresql://x"), /DATABASE_APP_URL/);
refuses((e) => (e.DATABASE_PUBLIC_URL = "postgresql://x"), /DATABASE_PUBLIC_URL/);
refuses((e) => (e.RESEND_API_KEY = "k"), /RESEND_API_KEY/);
refuses((e) => (e.NODE_ENV = "production"), /production/);
refuses((e) => (e.PILOT_APP_PASSWORD = "short"), /APP_PASSWORD/);
refuses((e) => (e.PILOT_AUTH_PASSWORD = e.PILOT_APP_PASSWORD), /differ/);
refuses((e) => (e.PILOT_AUTH_PASSWORD = "Z".repeat(40)), /AUTH_PASSWORD/);
