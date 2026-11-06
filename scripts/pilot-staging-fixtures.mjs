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
 * portal user bound to one) outside @rehearsal.invalid. Before inserting, the
 * unbound contacts the migrations seed (matched by address hash) are anonymized
 * and soft-deleted; any other non-synthetic user makes it refuse.
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

/**
 * Contacts the migrations themselves seed. Their ids are random per database, so
 * they are matched by the SHA-256 of the lower-cased primary address (no real
 * address is stored here). They carry no sign-in identity.
 */
export const LEGACY_EMAIL_SHA256 = Object.freeze([
  "72fd3a99c6bd31525950060d159599da0094ee4f41a1df749ca9e87d4ed1979b",
  "9d4d6b6b12aae503ef6b667dfd861ecf8aebd39f5bcf70d460757d2f19f83efd",
  "a73f7435971c90008d5902d876490ac15948c93bccedd9e2af7e1144398b6cbc",
  "bd8a0d2a5b5f4e67dd95e7797ecee64011b4eda7395c20a3336754f82c1f49e7",
  "da8eaf1a8281febac225134c209f451f48f0d4bca16e7b764add7cdfdd425ac6",
  "e6f33b2a4a1d835d25ca7b9b777a2a177353b0afc97e281b31665519243d3d03",
  "ebf4ea6c5a51faceda0abae9778014d1db94b57b228e1f3f947df78ecf44d748",
  "f337f6d73a779a1c29ac7c3b36de269658f7d838f68fc4599bbca512f131ec9d",
]);
/** Public-profile slugs the migrations seed with a real contact address. */
export const LEGACY_PROFILE_SLUGS = Object.freeze(["brandingcentres", "vinylwraptoronto", "wrapauthority", "workweartoronto"]);
const sha = (col) => `encode(sha256(convert_to(lower(${col}), 'UTF8')), 'hex')`;
// An address not already on the synthetic domain.
const REAL_EMAIL_RE = "[A-Za-z0-9._%+-]+@(?!rehearsal[.]invalid)[A-Za-z0-9.-]+";
// A live row in any of these means a migration contact is in use: refuse.
const LEGACY_DEPENDENTS = Object.freeze([
  ["sessions", "user_id"], ["identities", "user_id"], ["identity_bindings", "user_id"], ["recovery_codes", "user_id"],
  ["sso_tickets", "user_id"], ["api_keys", "created_by"], ["api_keys", "service_user_id"], ["invitations", "invited_by"],
  ["signin_links", "user_low"], ["signin_links", "user_high"],
]);

/**
 * Runs inside the seed transaction, before any synthetic insert. Refuses unless
 * every non-synthetic user is exactly a known migration contact with no sign-in
 * identity or credential and no dependent session/key/invitation/link. Then it
 * anonymizes only those rows (address -> legacy-<hash8>@rehearsal.invalid, name
 * neutral, soft-deleted, memberships removed) and scrubs their addresses from
 * user_emails, audit targets and the seeded public profiles. Nothing is deleted
 * from users or audit, so every foreign key still resolves. Returns counts only.
 * Idempotent: a second run matches no non-synthetic user.
 */
export async function anonymizeLegacyContacts(client) {
  const unknown = await client.query(
    `select count(*)::int n from users where email not like '%@${DOMAIN}' and ${sha("email")} <> all($1::text[])`,
    [LEGACY_EMAIL_SHA256],
  );
  if (unknown.rows[0].n !== 0) fail("users exist outside the known migration contacts and @rehearsal.invalid");
  const bound = await client.query(
    `select count(*)::int n from users where email not like '%@${DOMAIN}'
       and (auth_user_id is not null or workos_user_id is not null or totp_secret is not null or password_hash is not null)`,
  );
  if (bound.rows[0].n !== 0) fail("a migration contact has a sign-in identity or credential");
  const ids = (await client.query(`select id from users where email not like '%@${DOMAIN}'`)).rows.map((r) => r.id);
  for (const [t, c] of LEGACY_DEPENDENTS) {
    const r = await client.query(`select count(*)::int n from ${t} where ${c} = any($1::uuid[])`, [ids]);
    if (r.rows[0].n !== 0) fail(`a migration contact is referenced by live ${t}`);
  }
  const stat = { users: ids.length, memberships: 0, emails: 0, audit: 0, profiles: 0 };
  if (ids.length > 0) {
    stat.memberships = (await client.query("delete from role where user_id = any($1::uuid[])", [ids])).rowCount;
    stat.emails = (
      await client.query(
        `update user_emails set email = 'legacy-' || left(${sha("email")}, 8) || '@${DOMAIN}', verified_at = null
         where user_id = any($1::uuid[])`,
        [ids],
      )
    ).rowCount;
    await client.query(
      `update users set email = 'legacy-' || left(${sha("email")}, 8) || '@${DOMAIN}', full_name = 'Legacy Contact (synthetic)',
         is_staff = false, deleted_at = coalesce(deleted_at, now()), updated_at = now()
       where id = any($1::uuid[])`,
      [ids],
    );
  }
  stat.audit = (
    await client.query(
      `update audit_events set target = regexp_replace(target, '${REAL_EMAIL_RE}', 'redacted@${DOMAIN}', 'g')
       where target ~ '${REAL_EMAIL_RE}'`,
    )
  ).rowCount;
  stat.profiles = (
    await client.query(
      `update cid_public_profiles set profile = jsonb_set(profile, '{email}', to_jsonb('contact@${DOMAIN}'::text))
       where slug = any($1::text[]) and profile ? 'email' and profile->>'email' not like '%@${DOMAIN}'`,
      [LEGACY_PROFILE_SLUGS],
    )
  ).rowCount;
  return stat;
}

/**
 * Organizations the migrations seed (0012, 0059), by exact slug. Slugs and ids stay (they carry
 * the relations); only the display label is replaced. The synthetic pilot-* orgs are exempt.
 */
export const LEGACY_ORG_SLUGS = Object.freeze([
  "tbox-studio", "vinyl-wrap-toronto", "branding-centres", "rotary-store",
  "workwear-toronto", "416print", "print-three", "10xid", "wrap-authority",
]);
/** Public profiles seeded by 0059/0060 (the table CHECK allows only these five slugs). */
export const SEEDED_PROFILE_SLUGS = Object.freeze(["rotary", "brandingcentres", "vinylwraptoronto", "wrapauthority", "workweartoronto"]);
const SYNTH_PHONE = "+1 555-010-0100";
const SYNTH_ADDRESS = "1 Example Street, Example City (synthetic)";
/**
 * Jobs (0032) are deliberately NOT rewritten: their three titles are generic "TEST: ..." strings
 * (vehicle/film wording, no person or place) and job_events only records "migration 0032".
 *
 * Runs in the seed transaction. Refuses (no changes) if an organization outside the migration-seeded
 * slugs and the pilot-* fixtures exists. Then replaces the seeded organization names, the profile
 * display name / phone / address / maps link / email, and the one audit target that names an
 * organization. Nothing is deleted; ids, slugs, memberships and relations are untouched.
 * Idempotent. Returns counts only.
 */
export async function anonymizeLegacyBusinessData(client) {
  const pilot = ORGS.map((o) => o.slug);
  const unknown = await client.query(
    "select count(*)::int n from organizations where slug <> all($1::text[]) and slug <> all($2::text[])",
    [LEGACY_ORG_SLUGS, pilot],
  );
  if (unknown.rows[0].n !== 0) fail("organizations exist outside the known migration seeds and the pilot fixtures");
  const stat = { organizations: 0, profiles: 0, audit: 0 };
  stat.organizations = (
    await client.query(
      `update organizations set name = 'Legacy Org ' || left(encode(sha256(convert_to(slug, 'UTF8')), 'hex'), 8) || ' (synthetic)'
       where slug = any($1::text[]) and name <> 'Legacy Org ' || left(encode(sha256(convert_to(slug, 'UTF8')), 'hex'), 8) || ' (synthetic)'`,
      [LEGACY_ORG_SLUGS],
    )
  ).rowCount;
  stat.profiles = (
    await client.query(
      `update cid_public_profiles set profile =
         (profile - 'mapsUrl')
         || jsonb_build_object('displayName', 'Legacy Profile (synthetic)')
         || case when profile ? 'phone' then jsonb_build_object('phone', '${SYNTH_PHONE}') else '{}'::jsonb end
         || case when profile ? 'address' then jsonb_build_object('address', '${SYNTH_ADDRESS}') else '{}'::jsonb end
         || case when profile ? 'email' then jsonb_build_object('email', 'contact@${DOMAIN}') else '{}'::jsonb end
       where slug = any($1::text[])
         and (profile ? 'mapsUrl' or profile->>'displayName' is distinct from 'Legacy Profile (synthetic)'
           or (profile ? 'phone' and profile->>'phone' <> '${SYNTH_PHONE}')
           or (profile ? 'address' and profile->>'address' <> '${SYNTH_ADDRESS}')
           or (profile ? 'email' and profile->>'email' <> 'contact@${DOMAIN}'))`,
      [SEEDED_PROFILE_SLUGS],
    )
  ).rowCount;
  stat.audit = (
    await client.query("update audit_events set target = 'Legacy Org (0059, CiD rollout)' where target = 'Wrap Authority (0059, CiD rollout)'")
  ).rowCount;
  return stat;
}

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
    const cleaned = await anonymizeLegacyContacts(client);
    Object.assign(cleaned, { business: await anonymizeLegacyBusinessData(client) });

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
    return cleaned;
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
    const c = await seed(client, inputs);
    console.log(`anonymized legacy contacts: users=${c.users} memberships=${c.memberships} emails=${c.emails} audit=${c.audit} profiles=${c.profiles}`);
    console.log(`anonymized legacy business data: organizations=${c.business.organizations} profiles=${c.business.profiles} audit=${c.business.audit}`);
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
