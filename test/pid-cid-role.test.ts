import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, test } from "vitest";

test("PiD, CiD and role are tables and the old names preserve application access", async () => {
  const db = new Client({ connectionString: process.env.DATABASE_APP_URL });
  await db.connect();
  try {
    await db.query("begin");
    const relations = await db.query<{ relname: string; relkind: string }>(`
      select c.relname, c.relkind
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('PiD', 'CiD', 'role', 'people', 'organizations', 'memberships')
    `);
    expect(Object.fromEntries(relations.rows.map(({ relname, relkind }) => [relname, relkind]))).toEqual({
      PiD: "r", CiD: "r", role: "r", people: "v", organizations: "v", memberships: "v",
    });

    const pid = randomUUID();
    const slug = `identity-rename-${randomUUID()}`;
    const personAccess = await db.query(`
      select has_table_privilege('public.people', 'SELECT') as legacy_read,
             has_table_privilege('public."PiD"', 'SELECT') as pid_read,
             has_column_privilege('public.people', 'id', 'INSERT') as legacy_insert
    `);
    expect(personAccess.rows).toEqual([{ legacy_read: false, pid_read: false, legacy_insert: true }]);

    const company = await db.query<{ id: string }>(
      "insert into public.organizations (type, name, slug) values ('client', 'Rename fixture', $1) returning id",
      [slug],
    );
    const cid = company.rows[0]!.id;
    const account = await db.query<{ id: string }>(
      "insert into public.users (email) values ($1) returning id",
      [`${slug}@test.invalid`],
    );
    const accountId = account.rows[0]!.id;
    await db.query(
      `insert into public.memberships (user_id, organization_id, role) values ($1, $2, 'owner')
       on conflict (user_id, organization_id) do update set role = excluded.role`,
      [accountId, cid],
    );
    const roles = await db.query(
      'select role from public."role" where user_id = $1 and organization_id = $2',
      [accountId, cid],
    );
    expect(roles.rows).toEqual([{ role: "owner" }]);
    expect((await db.query('select slug from public."CiD" where id = $1', [cid])).rows).toEqual([{ slug }]);

    await db.query("insert into public.people (id) values ($1)", [pid]);
    await db.query("select set_config('app.org_id', $1, true)", [cid]);
    await db.query(
      "insert into public.directory_people (organization_id, person_id, display_name) values ($1, $2, $3)",
      [cid, pid, "Rename fixture person"],
    );
  } finally {
    try {
      await db.query("rollback");
    } finally {
      await db.end();
    }
  }
});
