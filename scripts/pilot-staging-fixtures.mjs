#!/usr/bin/env node
/**
 * STAGING-ONLY, OPTIONAL, ONE-SHOT synthetic sign-in fixture for the hosted
 * 10XiD pilot. Separate from the migration runner; run it only after
 * `npm run pilot:db-rehearsal` has passed.
 *
 *   npm run pilot:fixtures-seed
 *
 * Creates (idempotently, fixed ids):
 *   organizations  pilot-branding, pilot-vinyl                   (type client)
 *   accounts       pilot.manager@rehearsal.invalid   owner   pilot-branding
 *                  pilot.member@rehearsal.invalid    editor  pilot-branding
 *                  pilot.alternate@rehearsal.invalid manager pilot-vinyl
 *                  pilot.outside@rehearsal.invalid   member  pilot-vinyl only
 * Each account gets: a verified Better Auth identity bound to a portal account
 * (the end state of an accepted invitation), a credential password hashed with
 * Better Auth's own scrypt, and a CONFIRMED authenticator whose secret is
 * encrypted with BETTER_AUTH_SECRET exactly as lib/auth/mfa-gate.ts does.
 *
 * Environment (names only; values are never printed):
 *   RAILWAY_ENVIRONMENT_ID / PILOT_EXPECTED_DB_HOST / DATABASE_URL   as the runner
 *   PILOT_FIXTURES_TEST_ONLY   must be exactly "I_UNDERSTAND_THIS_IS_TEST_ONLY"
 *   PILOT_FIXTURE_PASSWORD     12-128 chars, new synthetic password for all four
 *   PILOT_FIXTURE_TOTP_SECRET  20-64 [A-Za-z0-9]; the raw secret string the app
 *                              stores (authenticator apps see its base32 form)
 *   BETTER_AUTH_SECRET         32+ chars; MUST equal the pilot login service's
 *                              value or the stored authenticator cannot be read
 * Must be absent: everything the runner forbids except BETTER_AUTH_SECRET, plus
 * the runner's own role passwords. No mail transport is touched or required.
 * Refuses to run if any real sign-in identity exists (an auth_users row, or a
 * portal user bound to one) outside @rehearsal.invalid. Unbound users that the
 * migrations themselves seed are left untouched.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { hashPassword, symmetricEncrypt } from "better-auth/crypto";
import { checkTarget, EXPECTED, GateError } from "./pilot-staging-db-rehearsal.mjs";

export const FLAG = "PILOT_FIXTURES_TEST_ONLY";
const DOMAIN = "rehearsal.invalid";

/** Fixed synthetic ids: stable across re-runs, obviously not real. */
export const ORGS = Object.freeze([
  { id: "00000000-0000-4000-8000-0000000a0001", slug: "pilot-branding", name: "Pilot Branding (synthetic)", owner: "manager" },
  { id: "00000000-0000-4000-8000-0000000a0002", slug: "pilot-vinyl", name: "Pilot Vinyl (synthetic)", owner: "alternate" },
]);
export const PEOPLE = Object.freeze([
  { key: "manager", org: "pilot-branding", role: "owner", name: "Pilot Manager", uid: "00000000-0000-4000-8000-0000000b0001", aid: "pilot-fixture-auth-manager" },
  { key: "member", org: "pilot-branding", role: "editor", name: "Pilot Member", uid: "00000000-0000-4000-8000-0000000b0002", aid: "pilot-fixture-auth-member" },
  { key: "alternate", org: "pilot-vinyl", role: "manager", name: "Pilot Alternate", uid: "00000000-0000-4000-8000-0000000b0003", aid: "pilot-fixture-auth-alternate" },
  { key: "outside", org: "pilot-vinyl", role: "member", name: "Pilot Outside", uid: "00000000-0000-4000-8000-0000000b0004", aid: "pilot-fixture-auth-outside" },
].map((p) => ({ ...p, email: `pilot.${p.key}@${DOMAIN}` })));

const RUNNER_ONLY = ["PILOT_APP_PASSWORD", "PILOT_AUTH_PASSWORD", "PILOT_DB_REHEARSAL_TEST_ONLY"];
const fail = (m) => {
  throw new GateError(`pilot fixtures refused: ${m}`);
};

/** Pure gate. Throws GateError before any connection; returns validated inputs. */
export function checkSeedGates(env = process.env) {
  for (const k of RUNNER_ONLY) if (env[k]) fail(`${k} must not be set for the fixture seed`);
  const url = checkTarget(env, { flagVar: FLAG, allow: ["BETTER_AUTH_SECRET"] });
  const password = env.PILOT_FIXTURE_PASSWORD ?? "";
  if (password.length < 12 || password.length > 128) fail("PILOT_FIXTURE_PASSWORD must be 12-128 characters");
  const totp = env.PILOT_FIXTURE_TOTP_SECRET ?? "";
  if (!/^[A-Za-z0-9]{20,64}$/.test(totp)) fail("PILOT_FIXTURE_TOTP_SECRET must be 20-64 letters/digits");
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32) fail("BETTER_AUTH_SECRET must be set, 32+ characters");
  const dbPassword = decodeURIComponent(url.password);
  if ([password, totp, secret].includes(dbPassword)) fail("fixture inputs must differ from the owner password");
  return { password, totp, secret, target: { host: url.hostname, database: EXPECTED.database } };
}

/** Insert/refresh every fixture row in one transaction. Owner connection; no output of secrets. */
export async function seed(client, { password, totp, secret }) {
  const passwordHash = await hashPassword(password);
  const encSecret = await symmetricEncrypt({ key: secret, data: totp });
  const encCodes = await symmetricEncrypt({ key: secret, data: "[]" });

  await client.query("begin");
  try {
    // Guard against real data: only synthetic accounts may exist.
    const stray = await client.query(
      `select (select count(*)::int from users where auth_user_id is not null and email not like '%@${DOMAIN}')
            + (select count(*)::int from auth_users where email not like '%@${DOMAIN}') n`,
    );
    if (stray.rows[0].n !== 0) fail("database already holds real sign-in identities outside @rehearsal.invalid");

    for (const o of ORGS) {
      await client.query(
        `insert into organizations (id, type, name, slug) values ($1,'client',$2,$3)
         on conflict (id) do update set name = excluded.name, deleted_at = null`,
        [o.id, o.name, o.slug],
      );
    }
    for (const p of PEOPLE) {
      const org = ORGS.find((o) => o.slug === p.org);
      // Verified from birth: auth_users_first_proof only fires on UPDATE, so
      // inserting email_verified = true never wipes the authenticator below.
      await client.query(
        `insert into auth_users (id, name, email, email_verified) values ($1,$2,$3,true)
         on conflict (id) do update set name = excluded.name`,
        [p.aid, p.name, p.email],
      );
      await client.query(
        `insert into auth_accounts (id, account_id, provider_id, user_id, password)
         values ($1,$2,'credential',$2,$3)
         on conflict (id) do update set password = excluded.password, updated_at = now()`,
        [`${p.aid}-credential`, p.aid, passwordHash],
      );
      await client.query(
        `insert into users (id, auth_user_id, email, full_name, email_verified_at)
         values ($1,$2,$3,$4,now())
         on conflict (id) do update set full_name = excluded.full_name`,
        [p.uid, p.aid, p.email, p.name],
      );
      // user_emails: the users_primary_email trigger (0010) writes the verified primary row.
      await client.query(
        `insert into memberships (id, user_id, organization_id, role) values ($1,$2,$3,$4)
         on conflict (user_id, organization_id) do update set role = excluded.role, updated_at = now()`,
        [p.uid.replace("0b000", "0d000"), p.uid, org.id, p.role],
      );
      await client.query(
        `insert into auth_two_factors (id, user_id, secret, backup_codes, verified)
         values ($1,$2,$3,$4,true)
         on conflict (user_id) do update set secret = excluded.secret, backup_codes = excluded.backup_codes,
           verified = true, failed_verification_count = 0, locked_until = null,
           last_used_step = null, enrolling_session_id = null`,
        [`${p.aid}-totp`, p.aid, encSecret, encCodes],
      );
    }
    for (const o of ORGS) {
      const owner = PEOPLE.find((p) => p.key === o.owner);
      await client.query("update organizations set owner_user_id = $1 where id = $2", [owner.uid, o.id]);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}

async function main() {
  const inputs = checkSeedGates(); // BEFORE any DB access
  console.log(`gates passed: host=${inputs.target.host} db=${inputs.target.database}`);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  await client.connect();
  try {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries;
    const { rows } = await client.query("select count(*)::int n from drizzle.__drizzle_migrations");
    if (rows[0].n !== journal.length) fail("migrations are not fully applied; run pilot:db-rehearsal first");
    await seed(client, inputs);
  } finally {
    await client.end().catch(() => {});
  }
  console.log(`seeded ${ORGS.length} organizations and ${PEOPLE.length} accounts`);
  console.log("PILOT_FIXTURES_OK");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (e) {
    console.error(e instanceof GateError ? e.message : `fixture error: ${e?.code ?? e?.name ?? "unknown"}`);
    process.exitCode = 1;
  }
}
