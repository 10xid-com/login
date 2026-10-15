import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";

/**
 * 0038: the website copy.
 *
 * Asked of Postgres directly, as the restricted role the application uses, so
 * what is proved is the database's rule. Two website connections are made as
 * the owner for the file and removed after it; every write as the application
 * happens inside a transaction that is rolled back.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const appRole = new Client({ connectionString: process.env.DATABASE_APP_URL });

let rotaryId = "";
let northstarId = "";
let rotarySite = "";
let northstarSite = "";

beforeAll(async () => {
  await owner.connect();
  await appRole.connect();
  const { rows } = await owner.query(`
    select
      (select id from organizations where slug = 'rotary')    as rotary,
      (select id from organizations where slug = 'northstar') as northstar,
      (select id from users where email = 'jane@rotary.test')  as jane,
      (select id from users where email = 'sam@northstar.test') as sam
  `);
  ({ rotary: rotaryId, northstar: northstarId } = rows[0]);
  expect(rotaryId, "seed data missing — run npm run db:seed").toBeTruthy();
  const made = await owner.query(
    `insert into site_connections (organization_id, site_url, connected_by) values
       ($1, 'https://copy-test-rotary.example.com', $3),
       ($2, 'https://copy-test-northstar.example.com', $4)
     returning id, organization_id`,
    [rotaryId, northstarId, rows[0].jane, rows[0].sam],
  );
  rotarySite = made.rows.find((r) => r.organization_id === rotaryId).id;
  northstarSite = made.rows.find((r) => r.organization_id === northstarId).id;
});

afterAll(async () => {
  for (const t of ["site_social_posts", "site_social_profiles", "site_posts", "site_stock_moves", "site_materials", "site_jobs", "site_clients", "site_copies"]) {
    await owner.query(`delete from ${t} where site_connection_id = any($1)`, [[rotarySite, northstarSite]]);
  }
  await owner.query("delete from site_connections where id = any($1)", [[rotarySite, northstarSite]]);
  await owner.end();
  await appRole.end();
});

/** Run as the application, scoped to one business (or staff surveying), and always roll back. */
async function as<T>(orgId: string | null, fn: () => Promise<T>, staff = false): Promise<T> {
  await appRole.query("begin");
  try {
    await appRole.query("select set_config('app.org_id', $1, true), set_config('app.is_staff', $2, true)", [orgId ?? "", staff ? "on" : "off"]);
    return await fn();
  } finally {
    await appRole.query("rollback");
  }
}

const insertJob = (site: string, org: string, id: number, name: string) =>
  appRole.query(
    `insert into site_jobs (site_connection_id, organization_id, source_id, customer_name, status) values ($1, $2, $3, $4, 'completed')`,
    [site, org, id, name],
  );

describe("the website copy", () => {
  test("a business writes and reads its own copy", async () => {
    await as(rotaryId, async () => {
      await insertJob(rotarySite, rotaryId, 1, "Hungarock Fleet");
      await appRole.query(
        `insert into site_copies (site_connection_id, organization_id, site_url, copied_at, counts)
         values ($1, $2, 'https://copy-test-rotary.example.com', now(), '{"jobs":1}')`,
        [rotarySite, rotaryId],
      );
      const { rows } = await appRole.query("select customer_name from site_jobs");
      expect(rows.map((r) => r.customer_name)).toEqual(["Hungarock Fleet"]);
    });
  });

  test("a business cannot write into another business's copy", async () => {
    await as(northstarId, async () => {
      await expect(insertJob(rotarySite, rotaryId, 2, "Not yours")).rejects.toThrow(/row-level security/);
    });
  });

  test("a record's connection must be its own business's", async () => {
    await as(northstarId, async () => {
      // Northstar's row, pointed at Rotary's website: the composite reference refuses it.
      await expect(insertJob(rotarySite, northstarId, 3, "Wrong site")).rejects.toThrow(/foreign key/);
    });
  });

  test("one business never sees another's copy; staff surveying see all", async () => {
    await owner.query(
      `insert into site_clients (site_connection_id, organization_id, source_id, name) values ($1, $2, 1, 'Rotary client'), ($3, $4, 1, 'Northstar client')`,
      [rotarySite, rotaryId, northstarSite, northstarId],
    );
    try {
      const seen = (org: string | null, staff = false) =>
        as(org, async () => (await appRole.query("select name from site_clients where site_connection_id = any($1) order by name", [[rotarySite, northstarSite]])).rows.map((r) => r.name), staff);
      expect(await seen(rotaryId)).toEqual(["Rotary client"]);
      expect(await seen(northstarId)).toEqual(["Northstar client"]);
      expect(await seen(null)).toEqual([]);
      expect(await seen(null, true)).toEqual(["Northstar client", "Rotary client"]);
    } finally {
      await owner.query("delete from site_clients where site_connection_id = any($1)", [[rotarySite, northstarSite]]);
    }
  });

  test("site_copy_targets() lists live website connections, without a business scope", async () => {
    await owner.query("update site_connections set disconnected_at = now() where id = $1", [northstarSite]);
    try {
      const targets = await as(null, async () => (await appRole.query("select * from site_copy_targets()")).rows);
      const ours = targets.filter((t) => [rotarySite, northstarSite].includes(t.site_connection_id));
      expect(ours).toEqual([
        { organization_id: rotaryId, site_connection_id: rotarySite, site_url: "https://copy-test-rotary.example.com", business: expect.any(String) },
      ]);
      // Without the function, the application sees no connections at all.
      const direct = await as(null, async () => (await appRole.query("select id from site_connections where id = any($1)", [[rotarySite, northstarSite]])).rows);
      expect(direct).toEqual([]);
    } finally {
      await owner.query("update site_connections set disconnected_at = null where id = $1", [northstarSite]);
    }
  });
});
