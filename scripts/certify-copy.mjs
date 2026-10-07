import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

/**
 * Certify a copy of the portal database against its source.
 *
 * Read-only on both sides. It compares, section by section, the things the
 * migration acceptance criteria in PROJECT_STATE.md name, and exits non-zero
 * if anything that must match does not:
 *
 *   2. migration history   the Drizzle journal, row for row, and against the
 *                          migration files in this repository (LF and CRLF)
 *   3. schema              the database's encoding and collation; columns,
 *                          constraints, indexes, functions, triggers, enums and
 *                          sequences in the certified schemas
 *   4. data                exact row counts and a checksum of every row, per
 *                          table, against the source, or row counts against a
 *                          baseline file (see BASELINE_FILE below)
 *   5. roles / grants      the restricted role's attributes, the roles granted
 *                          TO it, that it owns nothing, and every table grant
 *   6. RLS                 enabled/forced flags and every policy
 *   7. tenant context      on the copy, as the restricted role: no rows without
 *                          a tenant, one tenant's rows with one, nothing left
 *                          behind after the transaction
 *
 * Criterion 1 (the restore) is what produces the copy, and criterion 8 (the
 * isolation test suite) writes fixtures, so it belongs on a disposable branch
 * of the copy, not on the copy being certified.
 *
 * Usage (connection strings stay in the environment, never on the command line):
 *
 *   SOURCE_URL=postgres://owner@source/db \
 *   TARGET_URL=postgres://owner@copy/db \
 *   TARGET_APP_URL=postgres://portal_app@copy/db \
 *   node scripts/certify-copy.mjs
 *
 * TARGET_APP_URL is optional; without it section 7 is skipped and says so.
 * Object OWNERS are reported but not required to match: a copy restored with
 * --no-owner is owned by whoever restored it, which is expected. Nor are roles
 * that are MEMBERS of the restricted role (a managed platform's owner is
 * routinely given admin over roles it creates): they gain nothing the
 * restricted role does not already have. They are listed for review.
 *
 * Live source or frozen source. Comparing data against a source that is still
 * taking writes cannot match: the copy is the source as it was when the dump
 * was taken. At cutover, with writes stopped, compare against the live source
 * (the default, and the strict check). For a drill against a live source, set
 * BASELINE_FILE to the row counts recorded when the dump was taken (e.g.
 * docs/baselines/railway-2026-10-07.json): the copy's counts must equal those,
 * and differences from the live source are shown as drift, not failures.
 */

const SCHEMAS = ["public", "drizzle"];
const APP_ROLE = process.env.CERTIFY_APP_ROLE ?? "portal_app";

const failures = [];
const notes = [];

function section(title) {
  console.log(`\n== ${title}`);
}

/**
 * Compare two lists of rows by a key; record every difference.
 *
 * `similar(a, b)`, when given, marks a difference as one a person should look
 * at rather than an outright failure. It is used for exactly one thing: a
 * constraint whose definition differs only in its parentheses, which is what a
 * dump and restore does to nested ANDs — Postgres re-parses the text and
 * flattens `((a AND b) AND c)` into `(a AND b AND c)`. Both texts are printed,
 * so the judgement is made by reading them, not by this script.
 */
function compare(name, source, target, key = (r) => JSON.stringify(r), similar = null) {
  const a = new Map(source.map((r) => [key(r), r]));
  const b = new Map(target.map((r) => [key(r), r]));
  const onlySource = [...a.keys()].filter((k) => !b.has(k));
  const onlyTarget = [...b.keys()].filter((k) => !a.has(k));
  const differing = [...a.keys()].filter(
    (k) => b.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)),
  );
  const review = similar ? differing.filter((k) => similar(a.get(k), b.get(k))) : [];
  const changed = differing.filter((k) => !review.includes(k));
  for (const k of review) {
    console.log(`  warn  ${name}: ${k} differs only in parentheses; confirm by reading:`);
    console.log(`          source: ${JSON.stringify(a.get(k))}`);
    console.log(`          copy:   ${JSON.stringify(b.get(k))}`);
    notes.push(`${name}: ${k} differs only in parentheses (review the printed texts)`);
  }
  if (!onlySource.length && !onlyTarget.length && !changed.length) {
    console.log(`  ok    ${name} (${source.length}${review.length ? `, ${review.length} to review` : ""})`);
    return true;
  }
  console.log(`  FAIL  ${name}`);
  for (const k of onlySource.slice(0, 20)) console.log(`        only in source: ${k}`);
  for (const k of onlyTarget.slice(0, 20)) console.log(`        only in copy:   ${k}`);
  for (const k of changed.slice(0, 20)) {
    console.log(`        differs: ${k}`);
    console.log(`          source: ${JSON.stringify(a.get(k))}`);
    console.log(`          copy:   ${JSON.stringify(b.get(k))}`);
  }
  failures.push(name);
  return false;
}

async function readOnly(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

const q = async (c, sql, params = []) => (await c.query(sql, params)).rows;

async function catalog(c) {
  const out = {};

  out.version = (await q(c, "select current_setting('server_version') as v"))[0].v;

  // Sorting, LIKE ranges and text indexes all follow these, so a copy with a
  // different collation behaves differently even with identical rows. The
  // provider decides which settings count: with the builtin provider (Neon's
  // template0 default) lc_collate is ignored for sorting, so a matching
  // lc_collate alone proves nothing. `sorted` is the behaviour itself.
  const [db] = await q(
    c,
    `select pg_encoding_to_char(d.encoding) as encoding,
            d.datcollate as collate, d.datctype as ctype,
            to_jsonb(d)->>'datlocprovider' as provider,
            coalesce(to_jsonb(d)->>'datlocale', to_jsonb(d)->>'daticulocale') as locale,
            d.datcollversion as version
       from pg_database d where d.datname = current_database()`,
  );
  const [{ sorted }] = await q(
    c,
    `select array_agg(x order by x) as sorted
       from unnest(array['-', '1', 'a', 'A', 'z', 'Z', 'a b', 'a-b', 'ab', 'e', 'é', 'f']) x`,
  );
  out.collationVersion = db.version;
  delete db.version;
  // glibc treats "en_US.UTF-8" and "en_US.utf8" as the same locale: it
  // lowercases the codeset and drops its punctuation.
  const glibcName = (l) =>
    l && l.replace(/\.([^@]*)/, (_, set) => "." + set.toLowerCase().replace(/[^a-z0-9]/g, ""));
  out.database = [{ ...db, collate: glibcName(db.collate), ctype: glibcName(db.ctype), sorted }];

  out.journal = await q(
    c,
    `select id, hash, created_at::text as created_at
       from drizzle.__drizzle_migrations order by id`,
  ).catch(() => []);

  out.tables = await q(
    c,
    `select n.nspname as schema, c.relname as table,
            c.relrowsecurity as rls, c.relforcerowsecurity as forced,
            pg_get_userbyid(c.relowner) as owner
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p') and n.nspname = any($1)
      order by 1, 2`,
    [SCHEMAS],
  );

  out.columns = await q(
    c,
    `select table_schema as schema, table_name as table, column_name as column,
            data_type, udt_name, is_nullable, column_default, ordinal_position
       from information_schema.columns
      where table_schema = any($1)
      order by 1, 2, ordinal_position`,
    [SCHEMAS],
  );

  out.constraints = await q(
    c,
    `select n.nspname as schema, t.relname as table, con.conname as name,
            con.contype as type, pg_get_constraintdef(con.oid) as definition
       from pg_constraint con
       join pg_class t on t.oid = con.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = any($1)
      order by 1, 2, 3`,
    [SCHEMAS],
  );

  out.indexes = await q(
    c,
    `select schemaname as schema, tablename as table, indexname as name, indexdef
       from pg_indexes where schemaname = any($1) order by 1, 2, 3`,
    [SCHEMAS],
  );

  out.functions = await q(
    c,
    `select n.nspname as schema, p.proname as name,
            pg_get_function_identity_arguments(p.oid) as args,
            md5(pg_get_functiondef(p.oid)) as definition_md5
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($1) and p.prokind in ('f','p')
      order by 1, 2, 3`,
    [SCHEMAS],
  );

  out.triggers = await q(
    c,
    `select n.nspname as schema, t.relname as table, tg.tgname as name,
            pg_get_triggerdef(tg.oid) as definition, tg.tgenabled as enabled
       from pg_trigger tg
       join pg_class t on t.oid = tg.tgrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = any($1) and not tg.tgisinternal
      order by 1, 2, 3`,
    [SCHEMAS],
  );

  out.enums = await q(
    c,
    `select n.nspname as schema, t.typname as name,
            array_agg(e.enumlabel order by e.enumsortorder) as labels
       from pg_type t
       join pg_enum e on e.enumtypid = t.oid
       join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = any($1)
      group by 1, 2 order by 1, 2`,
    [SCHEMAS],
  );

  out.sequences = await q(
    c,
    `select schemaname as schema, sequencename as name, data_type::text,
            start_value::text, increment_by::text, last_value::text
       from pg_sequences where schemaname = any($1) order by 1, 2`,
    [SCHEMAS],
  );

  out.data = [];
  for (const t of out.tables) {
    const ident = `${pg.escapeIdentifier(t.schema)}.${pg.escapeIdentifier(t.table)}`;
    const [row] = await q(
      c,
      `select count(*)::bigint::text as rows,
              coalesce(md5(string_agg(x::text, E'\\n' order by x::text collate "C")), '-') as checksum
         from ${ident} x`,
    );
    out.data.push({ schema: t.schema, table: t.table, ...row });
  }

  out.role = await q(
    c,
    `select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
            rolreplication, rolcanlogin, rolinherit
       from pg_roles where rolname = $1`,
    [APP_ROLE],
  );

  // Roles granted TO the restricted role: these are what could widen it.
  out.memberOf = await q(
    c,
    `select r.rolname as granted_role, m.rolname as member
       from pg_auth_members am
       join pg_roles r on r.oid = am.roleid
       join pg_roles m on m.oid = am.member
      where m.rolname = $1
      order by 1, 2`,
    [APP_ROLE],
  );

  // Roles that are members OF it: reported, not required to match.
  out.members = await q(
    c,
    `select m.rolname as member, g.rolname as grantor,
            to_jsonb(am)->>'admin_option' as admin_option,
            to_jsonb(am)->>'inherit_option' as inherit_option,
            to_jsonb(am)->>'set_option' as set_option
       from pg_auth_members am
       join pg_roles r on r.oid = am.roleid
       join pg_roles m on m.oid = am.member
       left join pg_roles g on g.oid = am.grantor
      where r.rolname = $1
      order by 1`,
    [APP_ROLE],
  );

  out.appOwns = await q(
    c,
    `select n.nspname as schema, c.relname as name, c.relkind as kind
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where pg_get_userbyid(c.relowner) = $1 and n.nspname = any($2)
      order by 1, 2`,
    [APP_ROLE, SCHEMAS],
  );

  out.grants = await q(
    c,
    `select table_schema as schema, table_name as table, privilege_type as privilege
       from information_schema.role_table_grants
      where grantee = $1 and table_schema = any($2)
      order by 1, 2, 3`,
    [APP_ROLE, SCHEMAS],
  );

  out.policies = await q(
    c,
    `select schemaname as schema, tablename as table, policyname as name,
            permissive, roles::text as roles, cmd, qual, with_check
       from pg_policies where schemaname = any($1) order by 1, 2, 3`,
    [SCHEMAS],
  );

  return out;
}

/** The repository's migration files, hashed as Drizzle hashes them. */
function repositoryJournal() {
  try {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    return journal.entries.map((e) => {
      const sql = readFileSync(`drizzle/${e.tag}.sql`);
      const lf = createHash("sha256").update(sql).digest("hex");
      const crlf = createHash("sha256")
        .update(Buffer.from(sql.toString("utf8").replace(/\r?\n/g, "\r\n"), "utf8"))
        .digest("hex");
      return { id: e.idx + 1, tag: e.tag, lf, crlf };
    });
  } catch {
    return [];
  }
}

/** Criterion 7, on the copy, as the restricted role. Nothing is written. */
async function tenantContext(appUrl, ownerUrl) {
  const sample = await readOnly(ownerUrl, (c) =>
    q(
      c,
      `select organization_id::text as org, count(*)::int as n
         from public.jobs group by 1 order by 2 desc limit 1`,
    ),
  );

  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  try {
    const [who] = await q(client, "select current_user as u");
    if (who.u !== APP_ROLE) {
      failures.push("tenant context: wrong role");
      console.log(`  FAIL  TARGET_APP_URL connects as "${who.u}", not "${APP_ROLE}"`);
      return;
    }

    await client.query("begin read only");
    const [none] = await q(client, "select count(*)::int as n from public.jobs");
    await client.query("rollback");
    if (none.n === 0) console.log("  ok    no tenant set: jobs shows 0 rows");
    else {
      failures.push("tenant context: rows visible without a tenant");
      console.log(`  FAIL  no tenant set, yet jobs shows ${none.n} rows`);
    }

    if (!sample.length) {
      notes.push("tenant context: no jobs in the copy, so the scoped read was not exercised");
      console.log("  note  the copy has no jobs; the scoped read was not exercised");
      return;
    }

    await client.query("begin read only");
    await client.query("select set_config('app.org_id', $1, true)", [sample[0].org]);
    const [scoped] = await q(client, "select count(*)::int as n from public.jobs");
    const [foreign] = await q(
      client,
      "select count(*)::int as n from public.jobs where organization_id::text <> $1",
      [sample[0].org],
    );
    await client.query("rollback");
    if (scoped.n === sample[0].n && foreign.n === 0) {
      console.log(`  ok    one tenant set: jobs shows exactly its ${scoped.n} rows, none of anyone else's`);
    } else {
      failures.push("tenant context: scoped read");
      console.log(`  FAIL  one tenant set: saw ${scoped.n} (expected ${sample[0].n}), ${foreign.n} foreign`);
    }

    const [after] = await q(client, "select current_setting('app.org_id', true) as v");
    if (!after.v) console.log("  ok    the tenant setting did not outlive its transaction");
    else {
      failures.push("tenant context: setting leaked");
      console.log(`  FAIL  app.org_id is still "${after.v}" after rollback`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const { SOURCE_URL, TARGET_URL, TARGET_APP_URL } = process.env;
  if (!SOURCE_URL || !TARGET_URL) {
    console.error("Set SOURCE_URL and TARGET_URL (owner connections), and optionally TARGET_APP_URL.");
    process.exit(2);
  }

  const [source, target] = await Promise.all([
    readOnly(SOURCE_URL, catalog),
    readOnly(TARGET_URL, catalog),
  ]);
  console.log(`source PostgreSQL ${source.version}; copy PostgreSQL ${target.version}`);
  if (source.version.split(".")[0] !== target.version.split(".")[0]) {
    notes.push(`major versions differ (${source.version} vs ${target.version})`);
  }

  section("2. Migration history");
  compare("journal (id, hash, created_at)", source.journal, target.journal, (r) => String(r.id));
  const repo = repositoryJournal();
  if (repo.length) {
    for (const [label, journal] of [["source", source.journal], ["copy", target.journal]]) {
      const byId = new Map(journal.map((r) => [r.id, r.hash]));
      const lf = repo.filter((r) => byId.get(r.id) === r.lf).length;
      const crlf = repo.filter((r) => byId.get(r.id) === r.crlf && r.crlf !== r.lf).length;
      const missing = repo.filter((r) => !byId.has(r.id)).length;
      console.log(
        `  info  ${label} vs repository files: ${lf} match (LF), ${crlf} match only as CRLF, ` +
          `${repo.length - lf - crlf - missing} match neither, ${missing} not applied`,
      );
    }
  }

  section("3. Schema");
  compare("database encoding and collation", source.database, target.database, () => "database");
  if (source.collationVersion !== target.collationVersion) {
    console.log(
      `  info  collation library version: source ${source.collationVersion ?? "-"}, ` +
        `copy ${target.collationVersion ?? "-"} (the sorting sample above is what is compared)`,
    );
  }
  compare("columns", source.columns, target.columns, (r) => `${r.schema}.${r.table}.${r.column}`);
  const withoutParens = (r) => JSON.stringify({ ...r, definition: r.definition.replace(/[()\s]/g, "") });
  compare(
    "constraints",
    source.constraints,
    target.constraints,
    (r) => `${r.schema}.${r.table}.${r.name}`,
    (x, y) => x.type === "c" && withoutParens(x) === withoutParens(y),
  );
  compare("indexes", source.indexes, target.indexes, (r) => `${r.schema}.${r.name}`);
  compare("functions", source.functions, target.functions, (r) => `${r.schema}.${r.name}(${r.args})`);
  compare("triggers", source.triggers, target.triggers, (r) => `${r.schema}.${r.table}.${r.name}`);
  compare("enums", source.enums, target.enums, (r) => `${r.schema}.${r.name}`);
  compare("sequences", source.sequences, target.sequences, (r) => `${r.schema}.${r.name}`);

  section("4. Data");
  compare("tables present", source.tables.map((t) => `${t.schema}.${t.table}`), target.tables.map((t) => `${t.schema}.${t.table}`), (r) => r);
  const baselineFile = process.env.BASELINE_FILE;
  if (!baselineFile) {
    compare("row counts and row checksums", source.data, target.data, (r) => `${r.schema}.${r.table}`);
  } else {
    const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
    const expected = Object.entries(baseline.rowCounts).map(([table, rows]) => ({ table, rows: String(rows) }));
    const actual = target.data.map((r) => ({ table: `${r.schema}.${r.table}`, rows: r.rows }));
    compare(`copy row counts against ${baselineFile} (${baseline.capturedAt ?? "baseline"})`, expected, actual, (r) => r.table);
    const sourceByTable = new Map(source.data.map((r) => [`${r.schema}.${r.table}`, r]));
    const drift = target.data.filter((r) => {
      const s = sourceByTable.get(`${r.schema}.${r.table}`);
      return s && (s.rows !== r.rows || s.checksum !== r.checksum);
    });
    if (!drift.length) console.log("  info  no drift: the live source still matches the copy exactly");
    for (const r of drift) {
      const s = sourceByTable.get(`${r.schema}.${r.table}`);
      console.log(`  drift ${r.schema}.${r.table}: live source ${s.rows} rows, copy ${r.rows} rows${s.rows === r.rows ? " (same count, contents changed since the dump)" : ""}`);
    }
    if (drift.length) notes.push(`${drift.length} table(s) changed on the live source since the dump (shown as drift)`);
  }

  section(`5. Roles, ownership, grants (${APP_ROLE})`);
  if (!target.role.length) {
    failures.push("role missing on copy");
    console.log(`  FAIL  role ${APP_ROLE} does not exist on the copy`);
  } else {
    const r = target.role[0];
    const bad = ["rolsuper", "rolbypassrls", "rolcreatedb", "rolcreaterole", "rolreplication"].filter((k) => r[k]);
    if (bad.length || !r.rolcanlogin) {
      failures.push("role attributes");
      console.log(`  FAIL  ${APP_ROLE} on the copy: ${bad.join(", ") || ""}${r.rolcanlogin ? "" : " cannot log in"}`);
    } else console.log(`  ok    ${APP_ROLE} on the copy: LOGIN, and none of SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION`);
  }
  compare(`roles granted to ${APP_ROLE}`, source.memberOf, target.memberOf);
  for (const [label, side] of [["source", source], ["copy", target]]) {
    for (const m of side.members) {
      console.log(
        `  info  ${label}: ${m.member} is a member of ${APP_ROLE} (granted by ${m.grantor}; ` +
          `admin=${m.admin_option}, inherit=${m.inherit_option ?? "n/a"}, set=${m.set_option ?? "n/a"})`,
      );
    }
  }
  if (target.appOwns.length) {
    failures.push("app role owns objects");
    console.log(`  FAIL  ${APP_ROLE} owns ${target.appOwns.length} object(s) on the copy, e.g. ${target.appOwns[0].schema}.${target.appOwns[0].name}`);
  } else console.log(`  ok    ${APP_ROLE} owns nothing in ${SCHEMAS.join(", ")} on the copy`);
  compare("table grants", source.grants, target.grants);
  const owners = (t) => [...new Set(t.tables.map((x) => x.owner))].join(", ");
  console.log(`  info  table owners: source ${owners(source)}; copy ${owners(target)} (not required to match)`);

  section("6. Row-level security");
  const rlsFlags = (t) => t.tables.map((r) => ({ schema: r.schema, table: r.table, rls: r.rls, forced: r.forced }));
  compare("RLS flags", rlsFlags(source), rlsFlags(target), (r) => `${r.schema}.${r.table}`);
  compare("policies", source.policies, target.policies, (r) => `${r.schema}.${r.table}.${r.name}`);

  section("7. Transaction-local tenant context (on the copy)");
  if (TARGET_APP_URL) await tenantContext(TARGET_APP_URL, TARGET_URL);
  else {
    notes.push("section 7 skipped: TARGET_APP_URL not set");
    console.log("  skip  set TARGET_APP_URL (connecting as the restricted role) to run it");
  }

  console.log("");
  for (const n of notes) console.log(`note: ${n}`);
  if (failures.length) {
    console.log(`NOT CERTIFIED: ${failures.length} check(s) failed: ${failures.join("; ")}`);
    process.exitCode = 1;
  } else if (notes.some((n) => n.includes("review the printed texts"))) {
    console.log("CERTIFIED, WITH ITEMS TO REVIEW: every check matches apart from the warnings above, which a person must confirm.");
  } else {
    console.log("CERTIFIED: every compared check matches.");
  }
}

main().catch((error) => {
  console.error("certify-copy failed:", error.message);
  process.exitCode = 2;
});
