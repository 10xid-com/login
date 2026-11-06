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

import { anonymizeLegacyContacts, LEGACY_EMAIL_SHA256, LEGACY_PROFILE_SLUGS } from "./pilot-staging-fixtures.mjs";
/** Fake pg client: answers the n-count guards in order, records every statement. */
const fakeClient = (counts) => {
  const log = [];
  let i = 0;
  return {
    log,
    async query(sql) {
      log.push(sql);
      if (/select count\(\*\)::int n/.test(sql)) return { rows: [{ n: counts[i++] ?? 0 }] };
      if (/select id from users/.test(sql)) return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }] };
      return { rows: [], rowCount: 0 };
    },
  };
};
const mutates = (log) => log.some((s) => /^\s*(update|delete|insert)/i.test(s));
test("legacy contact hashes: eight distinct sha256 digests, no plaintext", () => {
  assert.equal(new Set(LEGACY_EMAIL_SHA256).size, 8);
  for (const h of LEGACY_EMAIL_SHA256) assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(LEGACY_PROFILE_SLUGS.length, 4);
});
test("cleanup refuses an unknown non-synthetic user before changing anything", async () => {
  const c = fakeClient([1]);
  await assert.rejects(anonymizeLegacyContacts(c), /outside the known migration contacts/);
  assert.equal(mutates(c.log), false);
});
test("cleanup refuses a migration contact that holds a sign-in identity", async () => {
  const c = fakeClient([0, 1]);
  await assert.rejects(anonymizeLegacyContacts(c), /sign-in identity or credential/);
  assert.equal(mutates(c.log), false);
});
test("cleanup refuses a migration contact referenced by a live session/key", async () => {
  const c = fakeClient([0, 0, 1]);
  await assert.rejects(anonymizeLegacyContacts(c), /referenced by live sessions/);
  assert.equal(mutates(c.log), false);
});

import { anonymizeLegacyBusinessData, LEGACY_ORG_SLUGS, SEEDED_PROFILE_SLUGS } from "./pilot-staging-fixtures.mjs";
test("business cleanup refuses an unknown organization before changing anything", async () => {
  const c = fakeClient([1]);
  await assert.rejects(anonymizeLegacyBusinessData(c), /outside the known migration seeds/);
  assert.equal(mutates(c.log), false);
});
test("business cleanup only updates (never deletes), by exact slug, and keeps the relations", async () => {
  const c = fakeClient([0]);
  const stat = await anonymizeLegacyBusinessData(c);
  assert.deepEqual(Object.keys(stat), ["organizations", "profiles", "audit"]);
  const writes = c.log.filter((s) => /^\s*(update|delete|insert)/i.test(s));
  assert.equal(writes.length, 3);
  for (const w of writes) assert.match(w, /^\s*update /i);
  assert.match(writes[0], /update organizations set name = /);
  assert.doesNotMatch(writes[0], /slug =\s*'|set slug|\bid\b\s*=/);
  assert.equal(LEGACY_ORG_SLUGS.length, 9);
  assert.equal(SEEDED_PROFILE_SLUGS.length, 5);
  assert.doesNotMatch(c.log.join("\n"), /Ronson|M9W|416-|647-/);
});
