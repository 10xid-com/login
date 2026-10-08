import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";

/**
 * 0024: a client business cannot be left without an owner by the portal.
 *
 * Exercised as the roles that matter: portal_app (the portal's own role, which
 * the guard binds) and the table owner (migrations, operators, fixtures, which
 * it deliberately does not).
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const app = new Client({ connectionString: process.env.DATABASE_APP_URL });
const app2 = new Client({ connectionString: process.env.DATABASE_APP_URL });
const TAG = `rm${Date.now().toString(36)}`;
const addr = (l: string) => `${l}-${TAG}@test.invalid`;
const orgs: string[] = [];

async function business(type: "client" | "internal" = "client") {
  const slug = `${TAG}-${orgs.length}`;
  const id = (
    await owner.query("insert into organizations (type, name, slug) values ($1, $2, $2) returning id", [type, slug])
  ).rows[0].id as string;
  orgs.push(id);
  return id;
}

async function person(label: string, orgId: string, role: string, opts: { service?: boolean } = {}) {
  const userId = (
    await owner.query("insert into users (email, is_service) values ($1, $2) returning id", [
      addr(`${label}-${orgs.length}`),
      opts.service ?? false,
    ])
  ).rows[0].id as string;
  await owner.query("insert into memberships (user_id, organization_id, role) values ($1, $2, $3)", [
    userId,
    orgId,
    role,
  ]);
  return userId;
}

const removeAs = (c: Client, orgId: string, userId: string) =>
  c.query("delete from memberships where organization_id = $1 and user_id = $2", [orgId, userId]);
const setRoleAs = (c: Client, orgId: string, userId: string, role: string) =>
  c.query("update memberships set role = $3 where organization_id = $1 and user_id = $2", [orgId, userId, role]);
const roleOf = async (orgId: string, userId: string) =>
  (await owner.query("select role from memberships where organization_id = $1 and user_id = $2", [orgId, userId]))
    .rows[0]?.role ?? null;

beforeAll(async () => {
  await Promise.all([owner.connect(), app.connect(), app2.connect()]);
});

afterAll(async () => {
  await owner.query("delete from memberships where organization_id = any($1::uuid[])", [orgs]);
  await owner.query("delete from user_emails where email like $1", [`%-${TAG}@test.invalid`]);
  await owner.query("delete from users where email like $1", [`%-${TAG}@test.invalid`]);
  await owner.query("delete from organizations where id = any($1::uuid[])", [orgs]);
  await Promise.all([owner.end(), app.end(), app2.end()]);
});

describe("the last owner", () => {
  test("may not be removed, or changed to another role, by the portal", async () => {
    const org = await business();
    const only = await person("only", org, "owner");

    await expect(removeAs(app, org, only)).rejects.toMatchObject({ constraint: "memberships_last_owner" });
    await expect(setRoleAs(app, org, only, "manager")).rejects.toMatchObject({
      constraint: "memberships_last_owner",
    });
    expect(await roleOf(org, only)).toBe("owner");
  });

  test("a service account or a deleted account does not count as the other owner", async () => {
    const org = await business();
    const real = await person("real", org, "owner");
    await person("key", org, "owner", { service: true });
    const gone = await person("gone", org, "owner");
    await owner.query("update users set deleted_at = now() where id = $1", [gone]);

    await expect(removeAs(app, org, real)).rejects.toMatchObject({ constraint: "memberships_last_owner" });
  });

  test("an owner may be removed or demoted while another owner remains", async () => {
    const org = await business();
    const a = await person("a", org, "owner");
    const b = await person("b", org, "owner");
    const c = await person("c", org, "owner");

    await setRoleAs(app, org, a, "manager");
    expect(await roleOf(org, a)).toBe("manager");
    await removeAs(app, org, b);
    expect(await roleOf(org, b)).toBeNull();
    // c is now the last.
    await expect(removeAs(app, org, c)).rejects.toMatchObject({ constraint: "memberships_last_owner" });
  });

  test("anybody who is not an owner may be removed or changed freely", async () => {
    const org = await business();
    await person("boss", org, "owner");
    const v = await person("v", org, "viewer");
    const m = await person("m", org, "manager");

    await setRoleAs(app, org, v, "editor");
    expect(await roleOf(org, v)).toBe("editor");
    await removeAs(app, org, m);
    expect(await roleOf(org, m)).toBeNull();
  });

  test("two owners removing each other at once: one succeeds, the other is refused", async () => {
    const org = await business();
    const a = await person("ra", org, "owner");
    const b = await person("rb", org, "owner");

    await app.query("begin");
    await app2.query("begin");
    try {
      await removeAs(app, org, a);
      // Blocks on the business's owner lock until the first commits, then
      // sees that a is gone.
      const second = removeAs(app2, org, b).then(
        () => "removed",
        (e: { constraint?: string }) => e.constraint ?? String(e),
      );
      await new Promise((r) => setTimeout(r, 200));
      await app.query("commit");
      expect(await second).toBe("memberships_last_owner");
    } finally {
      await app2.query("rollback");
      await app.query("rollback").catch(() => {});
    }
    expect(await roleOf(org, a)).toBeNull();
    expect(await roleOf(org, b)).toBe("owner");
  });
});

describe("what the guard leaves alone", () => {
  test("the table owner (migrations, operators, fixtures) may remove a last owner", async () => {
    const org = await business();
    const only = await person("own", org, "owner");
    await removeAs(owner, org, only);
    expect(await roleOf(org, only)).toBeNull();
  });

  test("the house and deleted businesses are not guarded", async () => {
    const house = await business("internal");
    const h = await person("h", house, "owner");
    await removeAs(app, house, h);
    expect(await roleOf(house, h)).toBeNull();

    const closed = await business();
    const c = await person("c", closed, "owner");
    await owner.query("update organizations set deleted_at = now() where id = $1", [closed]);
    await removeAs(app, closed, c);
    expect(await roleOf(closed, c)).toBeNull();
  });
});
