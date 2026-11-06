#!/usr/bin/env node
/**
 * STAGING-ONLY, ONE-SHOT migration rehearsal for the 10XiD pilot.
 *
 * Runs inside the private Railway `pilot-staging` environment against the clean
 * `pilot-postgres` service (database portal_ci, owner ci_owner). It:
 *
 *   1. refuses to touch the database unless every gate below passes
 *      (the gates read only process.env; no connection is opened before them),
 *   2. runs the existing `npm run db:migrate:prod` as the owner,
 *   3. gives the existing portal_app and portal_auth roles LOGIN and the fresh
 *      hex passwords from PILOT_APP_PASSWORD / PILOT_AUTH_PASSWORD,
 *   4. verifies Drizzle is applied through 0065, role attributes, no dangerous
 *      grants, function EXECUTE boundaries, and a real connection per role.
 *
 * It sends no email, seeds nothing, and prints no secret. The existing CI guard
 * (scripts/ci-db-guard.mjs) stays loopback-only and is deliberately untouched.
 *
 * Required environment (names only; values are never printed):
 *   RAILWAY_ENVIRONMENT_ID        must equal the pilot-staging id below
 *   PILOT_DB_REHEARSAL_TEST_ONLY  must be exactly "I_UNDERSTAND_THIS_IS_TEST_ONLY"
 *   PILOT_EXPECTED_DB_HOST        private host of pilot-postgres (*.railway.internal)
 *   DATABASE_URL                  postgresql://ci_owner:...@<that host>:5432/portal_ci
 *   PILOT_APP_PASSWORD            fresh hex, 32+ chars
 *   PILOT_AUTH_PASSWORD           fresh hex, 32+ chars, different from the above
 * Must be ABSENT: BOOTSTRAP_*, PORTAL_* (incl. PORTAL_APP_PASSWORD /
 *   PORTAL_AUTH_PASSWORD / PORTAL_HOST), DATABASE_APP_URL, AUTH_DATABASE_URL,
 *   DATABASE_PUBLIC_URL, email/provider keys, and any production marker.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";

export const EXPECTED = Object.freeze({
  railwayEnvironmentId: "fa3e9119-a1f0-4a1e-a789-76e40fda7f68",
  testOnlyFlag: "I_UNDERSTAND_THIS_IS_TEST_ONLY",
  database: "portal_ci",
  owner: "ci_owner",
  port: "5432",
  lastMigrationTag: "0065_signin_link_email_proof",
});

/** Variables that must not exist at all: production, bootstrap, mail, public DB. */
const FORBIDDEN_EXACT = [
  "DATABASE_APP_URL",
  "AUTH_DATABASE_URL",
  "DATABASE_PUBLIC_URL",
  "DATABASE_PRIVATE_URL",
  "POSTGRES_URL",
  "PGHOST",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "BETTER_AUTH_SECRET",
  "RESEND_API_KEY",
  "SENDGRID_API_KEY",
  "POSTMARK_SERVER_TOKEN",
  "MAILGUN_API_KEY",
  "SMTP_URL",
  "SMTP_HOST",
  "EMAIL_FROM",
  "RAILWAY_PUBLIC_DOMAIN",
];
const FORBIDDEN_PREFIX = ["BOOTSTRAP_", "PORTAL_", "SMTP_", "RESEND_", "STRIPE_"];

const HEX_PASSWORD = /^[0-9a-f]{32,128}$/;

export class GateError extends Error {}
const gateFail = (m) => {
  throw new GateError(`pilot rehearsal refused: ${m}`);
};

/**
 * Shared target gate (environment, host, URL). Throws GateError; touches nothing
 * outside `env`. `flagVar` names the test-only flag variable; `allow` exempts
 * named variables from the forbidden list (used only by the fixture seed).
 */
export function checkTarget(env = process.env, { flagVar = "PILOT_DB_REHEARSAL_TEST_ONLY", allow = [] } = {}) {
  if (env.RAILWAY_ENVIRONMENT_ID !== EXPECTED.railwayEnvironmentId) {
    gateFail("RAILWAY_ENVIRONMENT_ID is not the approved pilot-staging environment");
  }
  const name = (env.RAILWAY_ENVIRONMENT_NAME ?? "").toLowerCase();
  if (name && name !== "pilot-staging") gateFail("RAILWAY_ENVIRONMENT_NAME is not pilot-staging");
  if (env[flagVar] !== EXPECTED.testOnlyFlag) {
    gateFail("explicit test-only flag missing or wrong");
  }
  for (const k of ["NODE_ENV", "APP_ENV", "DEPLOY_ENV"]) {
    if (/prod/i.test(env[k] ?? "")) gateFail(`${k} looks like production`);
  }
  for (const k of Object.keys(env)) {
    if (!env[k]) continue;
    if (allow.includes(k)) continue;
    if (FORBIDDEN_EXACT.includes(k) || FORBIDDEN_PREFIX.some((p) => k.startsWith(p))) {
      gateFail(`forbidden variable present: ${k}`);
    }
  }

  const expectedHost = env.PILOT_EXPECTED_DB_HOST;
  if (!expectedHost || expectedHost !== expectedHost.trim()) gateFail("PILOT_EXPECTED_DB_HOST missing");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.railway\.internal$/.test(expectedHost)) {
    gateFail("PILOT_EXPECTED_DB_HOST must be a private *.railway.internal name");
  }
  if (!env.DATABASE_URL) gateFail("DATABASE_URL missing");
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    gateFail("DATABASE_URL malformed");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") gateFail("DATABASE_URL scheme");
  if (url.hostname !== expectedHost) gateFail("DATABASE_URL host is not the expected private host");
  if ((url.port || "5432") !== EXPECTED.port) gateFail("DATABASE_URL port");
  if (decodeURIComponent(url.username) !== EXPECTED.owner) gateFail("DATABASE_URL user");
  if (decodeURIComponent(url.pathname) !== `/${EXPECTED.database}`) gateFail("DATABASE_URL database");
  if (url.search || url.hash) gateFail("DATABASE_URL must have no query or fragment");
  if (!url.password) gateFail("DATABASE_URL has no password");
  return url;
}

/** Environment gate for the migration runner. Returns the parsed target (no password). */
export function checkGates(env = process.env) {
  const url = checkTarget(env);
  const app = env.PILOT_APP_PASSWORD;
  const auth = env.PILOT_AUTH_PASSWORD;
  if (!app || !HEX_PASSWORD.test(app)) gateFail("PILOT_APP_PASSWORD must be 32+ hex chars");
  if (!auth || !HEX_PASSWORD.test(auth)) gateFail("PILOT_AUTH_PASSWORD must be 32+ hex chars");
  if (app === auth) gateFail("app and auth passwords must differ");
  if (decodeURIComponent(url.password) === app || decodeURIComponent(url.password) === auth) {
    gateFail("role passwords must differ from the owner password");
  }
  return { host: url.hostname, port: EXPECTED.port, database: EXPECTED.database };
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function withClient(config, fn) {
  const c = new pg.Client({ ...config, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

async function configureRole(owner, role, password) {
  // Password goes through a session setting and the server's format(%L); it is
  // never concatenated into SQL here. role is a fixed literal chosen below.
  if (role !== "portal_app" && role !== "portal_auth") throw new Error("bad role");
  await owner.query("SELECT set_config('pilot.pw', $1, false)", [password]);
  await owner.query(
    `DO $$ BEGIN EXECUTE format('ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', current_setting('pilot.pw')); END $$;`,
  );
  await owner.query("SELECT set_config('pilot.pw', '', false)");
}

async function verifyOwnerSide(owner) {
  const { rows: ident } = await owner.query(
    "select current_user u, current_database() d, version() v, (select rolsuper from pg_roles where rolname=current_user) su",
  );
  check("owner identity ci_owner@portal_ci", ident[0].u === EXPECTED.owner && ident[0].d === EXPECTED.database);
  check("server is PostgreSQL 18", /^PostgreSQL 18\./.test(ident[0].v));

  // Drizzle through 0065: row count == journal length, and every journal
  // timestamp (folderMillis) is recorded.
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries;
  const last = journal[journal.length - 1];
  check("journal ends at 0065", last.tag === EXPECTED.lastMigrationTag, `entries=${journal.length}`);
  const { rows: applied } = await owner.query(
    "select created_at::bigint as t from drizzle.__drizzle_migrations",
  );
  const have = new Set(applied.map((r) => String(r.t)));
  const missing = journal.filter((e) => !have.has(String(e.when))).map((e) => e.tag);
  check(
    "Drizzle applied through 0065",
    applied.length === journal.length && missing.length === 0,
    `applied=${applied.length} journal=${journal.length} missing=${missing.join(",") || "none"}`,
  );

  // Role attributes.
  const { rows: roles } = await owner.query(
    "select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication from pg_roles where rolname in ('portal_app','portal_auth')",
  );
  for (const n of ["portal_app", "portal_auth"]) {
    const r = roles.find((x) => x.rolname === n);
    check(
      `${n} LOGIN, no super/bypassrls/createdb/createrole/replication`,
      r && r.rolcanlogin && !r.rolsuper && !r.rolbypassrls && !r.rolcreatedb && !r.rolcreaterole && !r.rolreplication,
    );
  }
  const { rows: members } = await owner.query(
    `select r.rolname member, g.rolname granted from pg_auth_members m
       join pg_roles r on r.oid=m.member join pg_roles g on g.oid=m.roleid
      where r.rolname in ('portal_app','portal_auth')`,
  );
  check("portal roles are members of no role", members.length === 0, members.map((m) => `${m.member}>${m.granted}`).join(","));

  // Ownership and dangerous grants.
  const { rows: owned } = await owner.query(
    `select count(*)::int n from pg_class c join pg_roles r on r.oid=c.relowner
      where r.rolname in ('portal_app','portal_auth') and c.relnamespace not in (select oid from pg_namespace where nspname in ('pg_catalog','information_schema'))`,
  );
  check("portal roles own no relations", owned[0].n === 0);
  const { rows: schemaOwned } = await owner.query(
    `select count(*)::int n from pg_namespace n join pg_roles r on r.oid=n.nspowner where r.rolname in ('portal_app','portal_auth')`,
  );
  check("portal roles own no schemas", schemaOwned[0].n === 0);
  const { rows: danger } = await owner.query(
    `select r.rolname, c.relname, p.priv
       from pg_roles r
       cross join pg_class c
       join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
       cross join (values ('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
      where r.rolname in ('portal_app','portal_auth') and c.relkind in ('r','p')
        and has_table_privilege(r.rolname, c.oid, p.priv)`,
  );
  check("no TRUNCATE/REFERENCES/TRIGGER on public tables", danger.length === 0, `${danger.length} found`);
  const { rows: grantOpt } = await owner.query(
    `select count(*)::int n from pg_class c, aclexplode(c.relacl) a
      join pg_roles r on r.oid=a.grantee
      where r.rolname in ('portal_app','portal_auth') and a.is_grantable`,
  );
  check("no GRANT OPTION held on relations", grantOpt[0].n === 0);
  const { rows: schemaPriv } = await owner.query(
    `select r.rolname, has_schema_privilege(r.rolname,'public','CREATE') c,
            has_database_privilege(r.rolname,'portal_ci','CREATE') dc,
            has_database_privilege(r.rolname,'portal_ci','TEMPORARY') dt
       from pg_roles r where r.rolname in ('portal_app','portal_auth')`,
  );
  check("no CREATE on schema public or database", schemaPriv.every((r) => !r.c && !r.dc));

  // RLS: every public table that has policies has RLS enabled; tenant tables
  // are RLS-forced-or-enabled for non-owner roles. (Full coverage: db:rls-check.)
  const { rows: rlsGap } = await owner.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
      where c.relkind='r' and not c.relrowsecurity
        and exists (select 1 from pg_policy p where p.polrelid=c.oid)`,
  );
  check("no table has policies with RLS disabled", rlsGap.length === 0, rlsGap.map((r) => r.relname).join(","));
  const { rows: rlsOn } = await owner.query(
    "select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace and n.nspname='public' where c.relkind='r' and c.relrowsecurity",
  );
  check("RLS enabled on at least the tenant tables", rlsOn[0].n >= 40, `rls tables=${rlsOn[0].n}`);

  // Function EXECUTE boundaries.
  const exec = async (role, fn) =>
    (await owner.query("select has_function_privilege($1, p.oid, 'EXECUTE') ok from pg_proc p where p.oid = $2::regprocedure", [role, fn])).rows[0]?.ok;
  const publicExec = async (fn) =>
    (await owner.query(
      "select (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE')) ok from pg_proc p where p.oid=$1::regprocedure",
      [fn],
    )).rows[0]?.ok;
  const boundaries = [
    ["portal_app", "auth_session_touch(text)", true],
    ["portal_app", "auth_revoke_session(text)", true],
    ["portal_auth", "operator_open_bindings()", true],
    ["portal_app", "operator_open_bindings()", false],
    ["portal_auth", "signin_link_start(text,text,text,text)", true],
    ["portal_auth", "signin_link_complete(text,text)", true],
  ];
  for (const [role, fn, want] of boundaries) {
    const got = await exec(role, fn).catch(() => undefined);
    check(`${role} EXECUTE ${fn} = ${want}`, got === want);
  }
  for (const fn of ["auth_session_touch(text)", "operator_open_bindings()", "signin_link_start(text,text,text,text)"]) {
    const got = await publicExec(fn).catch(() => undefined);
    check(`PUBLIC cannot EXECUTE ${fn}`, got === false);
  }
  const { rows: openDefiners } = await owner.query(
    `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as f
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prosecdef and p.prokind='f'
        and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE'))`,
  );
  check("no SECURITY DEFINER function in public is PUBLIC-executable", openDefiners.length === 0, openDefiners.map((r) => r.f).join("; "));
}

async function verifyRoleConnection(base, user, password, otherTables) {
  await withClient({ host: base.host, port: Number(base.port), database: base.database, user, password }, async (c) => {
    const { rows } = await c.query(
      "select current_user u, r.rolsuper s, r.rolbypassrls b, (select count(*)::int from pg_tables where tableowner=current_user and schemaname='public') owns from pg_roles r where r.rolname=current_user",
    );
    check(
      `${user} connects; not super/bypassrls/owner`,
      rows[0].u === user && !rows[0].s && !rows[0].b && rows[0].owns === 0,
    );
    for (const sql of ["create table pilot_probe(x int)", "truncate users"]) {
      const denied = await c.query(sql).then(() => false, (e) => e.code === "42501");
      check(`${user} denied: ${sql}`, denied);
    }
    for (const t of otherTables) {
      // An unscoped read must fail on permission or come back empty, never leak rows.
      const r = await c.query(`select count(*)::int n from ${t}`).then((x) => x.rows[0].n, () => 0);
      check(`${user} unscoped read of ${t} returns 0 rows`, r === 0);
    }
  });
}

async function main() {
  const base = checkGates(); // BEFORE any DB access
  console.log(`gates passed: host=${base.host} db=${base.database} env=${EXPECTED.railwayEnvironmentId}`);

  // Child gets only what migrate.mjs needs. No PORTAL_*/BOOTSTRAP_* by construction.
  const migrate = spawnSync("npm", ["run", "db:migrate:prod"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: process.env.DATABASE_URL },
  });
  check("npm run db:migrate:prod exits 0", migrate.status === 0, `status=${migrate.status}`);
  if (migrate.status !== 0) return;

  const ownerUrl = process.env.DATABASE_URL;
  await withClient({ connectionString: ownerUrl }, async (owner) => {
    await configureRole(owner, "portal_app", process.env.PILOT_APP_PASSWORD);
    await configureRole(owner, "portal_auth", process.env.PILOT_AUTH_PASSWORD);
    check("portal_app and portal_auth configured with LOGIN", true);
    await verifyOwnerSide(owner);
  });

  await verifyRoleConnection(base, "portal_app", process.env.PILOT_APP_PASSWORD, ["jobs", "memberships"]);
  await verifyRoleConnection(base, "portal_auth", process.env.PILOT_AUTH_PASSWORD, ["jobs", "memberships"]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (e) {
    // Never print e.message verbatim for pg errors (connection strings can appear).
    console.error(e instanceof GateError ? e.message : `rehearsal error: ${e?.code ?? e?.name ?? "unknown"}`);
    process.exitCode = 1;
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nsummary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
  else if (process.exitCode !== 1) console.log("PILOT_DB_REHEARSAL_OK");
}
