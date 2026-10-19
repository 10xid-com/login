import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";

/**
 * How a container was acquired (0049), proved against the RESTRICTED role.
 *
 * Same method as test/inventory.test.ts: each test runs in one transaction
 * that is rolled back; owner-only fixtures are made as the owner, and
 * everything a business does is done after `set local role portal_app` with a
 * transaction-local app.org_id. The data is synthetic and belongs to nobody.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });

beforeAll(() => owner.connect());
afterAll(() => owner.end());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function q(text: string, params: unknown[] = []): Promise<Row[]> {
  return (await owner.query(text, params)).rows;
}

async function one(text: string, params: unknown[] = []): Promise<Row> {
  const rows = await q(text, params);
  expect(rows.length, text).toBe(1);
  return rows[0];
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function inRollback(fn: () => Promise<void>) {
  await owner.query("begin");
  try {
    await fn();
  } finally {
    await owner.query("rollback");
  }
}

/** Run a statement that must fail, without aborting the surrounding transaction. */
async function fails(text: string, params: unknown[], pattern: RegExp) {
  await owner.query("savepoint expect_failure");
  let error: unknown = null;
  try {
    await owner.query(text, params);
  } catch (e) {
    error = e;
  }
  await owner.query("rollback to savepoint expect_failure");
  expect(error, `expected to fail: ${text}`).not.toBeNull();
  expect(String((error as Error).message)).toMatch(pattern);
}

const tag = () => randomBytes(4).toString("hex");

async function business(name = "Acquisition test") {
  const t = tag();
  const org = (await one(
    `insert into organizations (type, name, slug) values ('client', $1, $2) returning id`,
    [`${name} ${t}`, `acquisition-test-${t}`],
  )).id as string;
  const user = (await one(
    `insert into users (email, full_name) values ($1, $2) returning id`,
    [`acquisition-${t}@example.test`, `Acquisition ${t}`],
  )).id as string;
  await q(`insert into memberships (user_id, organization_id, role) values ($1, $2, 'owner')`, [user, org]);
  return { org, user };
}

async function asApp(org: string, user = "") {
  await q("set local role portal_app");
  await q(
    "select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.is_staff', 'off', true)",
    [org, user],
  );
}

async function asOwner() {
  await q("reset role");
}

const ORG = "current_setting('app.org_id')::uuid";

async function product(name: string) {
  return (await one(
    `insert into inventory_products (organization_id, name, package_quantity, package_unit) values (${ORG}, $1, 250, 'g') returning id`,
    [name],
  )).id as string;
}

async function lot(productId: string) {
  return (await one(`insert into inventory_lots (organization_id, product_id) values (${ORG}, $1) returning id`, [productId]))
    .id as string;
}

async function container(lotId: string) {
  return (await one(
    `insert into inventory_containers (organization_id, lot_id, status, nominal_quantity, nominal_unit)
     values (${ORG}, $1, 'sealed', 250, 'g') returning id`,
    [lotId],
  )).id as string;
}

async function opening(containerId: string) {
  await q(
    `insert into inventory_movements (organization_id, container_id, kind, quantity, unit, basis)
     values (${ORG}, $1, 'opening', 250, 'g', 'labelled_unopened')`,
    [containerId],
  );
}

async function balanceOf(containerId: string) {
  const row = await one(
    `select balance, balance_basis from inventory_container_balances where container_id = $1`,
    [containerId],
  );
  return { balance: num(row.balance), basis: row.balance_basis as string };
}

/** A seller: a company in the shared directory and this business's relationship with it. */
async function seller(name: string) {
  const listed = await one(`select company_id from list_company($1)`, [`${name} ${tag()}`]);
  return (await one(
    `insert into inventory_businesses (organization_id, company_id, is_vendor) values (${ORG}, $1, true) returning id`,
    [listed.company_id],
  )).id as string;
}

/** A private file of this business: an invoice PDF unless said otherwise. */
async function paper(org: string, user: string, state = "stored", kind = "invoice") {
  return (await one(
    `insert into inventory_documents (organization_id, kind, content_type, storage_key, byte_size, sha256, uploaded_by, state)
     values (${ORG}, $1, 'application/pdf', $2, 2048, $3, $4, $5) returning id`,
    [kind, `inventory/${org}/${randomBytes(18).toString("base64url")}.pdf`, randomBytes(32), user, state],
  )).id as string;
}

async function attach(documentId: string, containerId: string) {
  await q(
    `insert into inventory_document_links (organization_id, document_id, container_id, role) values (${ORG}, $1, $2, 'purchase')`,
    [documentId, containerId],
  );
}

/** The INSERT for one record, as [sql, params], so a test can expect it to fail. */
function record(containerId: string, facts: Record<string, unknown> = {}): [string, unknown[]] {
  const cols = ["organization_id", "container_id", ...Object.keys(facts)];
  const vals = [containerId, ...Object.values(facts)];
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
  return [
    `insert into inventory_container_acquisitions (${cols.join(", ")}) values (${ORG}, ${placeholders}) returning *`,
    vals,
  ];
}

async function acquire(containerId: string, facts: Record<string, unknown> = {}) {
  return one(...record(containerId, facts));
}

/** The current record: the one nothing supersedes. */
async function current(containerId: string) {
  return q(
    `select a.* from inventory_container_acquisitions a
      where a.container_id = $1
        and not exists (select 1 from inventory_container_acquisitions b
                         where b.organization_id = a.organization_id and b.supersedes_id = a.id)`,
    [containerId],
  );
}

const TABLE = "inventory_container_acquisitions";

describe("0049 migration", () => {
  test("0049 is re-runnable; the table is tenant-protected and append-only for the application", async () => {
    const sql = await readFile("drizzle/0049_container_acquisitions.sql", "utf8");
    await inRollback(async () => {
      await owner.query(sql);
      await owner.query(sql);
      expect((await one(`select rowsecurity from pg_tables where schemaname = 'public' and tablename = $1`, [TABLE])).rowsecurity).toBe(true);
      const policies = await q(
        `select policyname, roles::text as roles from pg_policies where schemaname = 'public' and tablename = $1`,
        [TABLE],
      );
      expect(policies).toEqual([{ policyname: `${TABLE}_tenant_isolation`, roles: "{portal_app}" }]);
      const grants = await q(
        `select privilege_type from information_schema.role_table_grants
          where grantee = 'portal_app' and table_schema = 'public' and table_name = $1 order by 1`,
        [TABLE],
      );
      expect(grants.map((g) => g.privilege_type)).toEqual(["INSERT", "SELECT"]);
    });
  });
});

describe("purchases of a container", () => {
  test("two jars of one lot can come from two sellers at two prices; the lot and product are untouched", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const p = await product("Shared lot powder");
      const l = await lot(p);
      const [jar1, jar2] = [await container(l), await container(l)];
      const lotBefore = await one(`select * from inventory_lots where id = $1`, [l]);
      const productBefore = await one(`select * from inventory_products where id = $1`, [p]);
      const [shopA, shopB] = [await seller("Shop A"), await seller("Shop B")];

      await acquire(jar1, { vendor_id: shopA, price: "18.50", currency: "CAD", acquired_on: "2026-09-01", recorded_by: user });
      await acquire(jar2, { vendor_id: shopB, price: "21.00", currency: "USD", acquired_on: "2026-10-02", recorded_by: user });

      const [a, b] = [(await current(jar1))[0], (await current(jar2))[0]];
      expect([a.vendor_id, num(a.price), a.currency]).toEqual([shopA, 18.5, "CAD"]);
      expect([b.vendor_id, num(b.price), b.currency]).toEqual([shopB, 21, "USD"]);
      expect(await one(`select * from inventory_lots where id = $1`, [l])).toEqual(lotBefore);
      expect(await one(`select * from inventory_products where id = $1`, [p])).toEqual(productBefore);
    });
  });

  test("a first record says something; a correction is a new record that can clear a fact; history is kept as one chain", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const jar = await container(await lot(await product("Corrected powder")));
      const shop = await seller("Wrong shop");

      await fails(...record(jar), /inventory_container_acquisitions_says_something/);
      await fails(...record(jar, { note: "   " }), /inventory_container_acquisitions_says_something/);
      const first = await acquire(jar, { vendor_id: shop, acquired_on: "2026-08-15" });
      // A second "first" record for the same jar is refused: corrections supersede.
      await fails(...record(jar, { price: "5.00", currency: "CAD" }), /inventory_container_acquisitions_one_first/);

      // The seller was wrong and is not known after all; the price is.
      const second = await acquire(jar, { supersedes_id: first.id, acquired_on: "2026-08-15", price: "12.00", currency: "CAD" });
      expect(second.vendor_id).toBeNull();
      // The chain cannot fork: the first record is already corrected.
      await fails(...record(jar, { supersedes_id: first.id, note: "fork" }), /inventory_container_acquisitions_superseded_once/);
      // Everything turns out to be unknown: a correction may say nothing.
      const third = await acquire(jar, { supersedes_id: second.id });

      expect((await current(jar)).map((r) => r.id)).toEqual([third.id]);
      const all = await q(`select id, vendor_id, price, acquired_on::text as acquired from ${TABLE} where container_id = $1 order by created_at`, [jar]);
      expect(all).toEqual([
        { id: first.id, vendor_id: shop, price: null, acquired: "2026-08-15" },
        { id: second.id, vendor_id: null, price: "12.00", acquired: "2026-08-15" },
        { id: third.id, vendor_id: null, price: null, acquired: null },
      ]);
    });
  });

  test("a correction replaces an earlier record of the same container, never another jar's", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const l = await lot(await product("Two jars"));
      const [jar1, jar2] = [await container(l), await container(l)];
      const first = await acquire(jar1, { note: "From the market" });
      await fails(...record(jar2, { supersedes_id: first.id, note: "Not this jar" }), /earlier record of the same container/);
      // Not yet written (a loop of corrections in one statement) is refused the same way.
      const [x, y] = [randomUUID(), randomUUID()];
      await fails(
        `insert into ${TABLE} (id, organization_id, container_id, supersedes_id, note)
         values ($1, ${ORG}, $3, $2, 'x'), ($2, ${ORG}, $3, $1, 'y')`,
        [x, y, jar1],
        /earlier record of the same container/,
      );
    });
  });

  test("a price is for this package, never without its currency, never negative; zero only as entered", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const jar = await container(await lot(await product("Priced powder")));
      await fails(...record(jar, { price: "9.99" }), /inventory_container_acquisitions_currency/);
      await fails(...record(jar, { currency: "CAD", note: "currency alone" }), /inventory_container_acquisitions_currency/);
      await fails(...record(jar, { price: "9.99", currency: "cad" }), /inventory_container_acquisitions_currency/);
      await fails(...record(jar, { price: "9.99", currency: "CA" }), /inventory_container_acquisitions_currency/);
      await fails(...record(jar, { price: "-1.00", currency: "CAD" }), /inventory_container_acquisitions_price/);
      const gift = await acquire(jar, { price: "0", currency: "CAD", note: "A free sample" });
      expect([num(gift.price), gift.currency]).toEqual([0, "CAD"]);
    });
  });

  test("paperwork must have arrived, be this business's, and be attached to the jar first; one invoice serves several jars", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const l = await lot(await product("Invoiced powder"));
      const [jar1, jar2, jar3] = [await container(l), await container(l), await container(l)];

      const pending = await paper(org, user, "pending");
      await attach(pending, jar1);
      await fails(...record(jar1, { document_id: pending }), /has not finished arriving/);

      const invoice = await paper(org, user);
      await fails(...record(jar1, { document_id: invoice }), /Attach the document to this container first/);
      await attach(invoice, jar2);
      await fails(...record(jar1, { document_id: invoice }), /Attach the document to this container first/);
      await attach(invoice, jar1);
      await acquire(jar1, { document_id: invoice });
      await acquire(jar2, { document_id: invoice });

      // The file stays one document; each jar reaches it through its own link.
      expect(num((await one(`select count(*) from inventory_documents where id = $1`, [invoice])).count)).toBe(1);
      const links = await q(`select container_id from inventory_document_links where document_id = $1 order by container_id`, [invoice]);
      expect(links.map((r) => r.container_id).sort()).toEqual([jar1, jar2].sort());
      expect(await current(jar3)).toEqual([]);
    });
  });

  test("an order line's seller is its order's vendor, and its product is this jar's", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const [p, other] = [await product("Ordered powder"), await product("Something else")];
      const jar = await container(await lot(p));
      const [shop, elsewhere] = [await seller("Order shop"), await seller("Other shop")];
      const order = (await one(`insert into inventory_orders (organization_id, vendor_id, currency) values (${ORG}, $1, 'CAD') returning id`, [shop])).id;
      const line = async (productId: string | null) =>
        (await one(
          `insert into inventory_order_lines (organization_id, order_id, description, packages, product_id, unit_price)
           values (${ORG}, $1, 'Powder 250 g', 1, $2, 14.5) returning id`,
          [order, productId],
        )).id as string;

      const [right, wrong, unnamed] = [await line(p), await line(other), await line(null)];
      await fails(...record(jar, { order_line_id: right, vendor_id: elsewhere }), /different seller/);
      await fails(...record(jar, { order_line_id: wrong }), /different product/);
      const first = await acquire(jar, { order_line_id: right, price: "14.50", currency: "CAD" });
      expect(first.vendor_id).toBe(shop);
      const corrected = await acquire(jar, { supersedes_id: first.id, order_line_id: unnamed, vendor_id: shop });
      expect(corrected.vendor_id).toBe(shop);
    });
  });

  test("records are kept as written: the portal cannot change or remove them, nor the owner, nor what they cite", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const p = await product("Kept powder");
      const jar = await container(await lot(p));
      const shop = await seller("Kept shop");
      const invoice = await paper(org, user);
      await attach(invoice, jar);
      const order = (await one(`insert into inventory_orders (organization_id, vendor_id) values (${ORG}, $1) returning id`, [shop])).id;
      const orderLine = (await one(
        `insert into inventory_order_lines (organization_id, order_id, description, packages, product_id) values (${ORG}, $1, 'Kept', 1, $2) returning id`,
        [order, p],
      )).id;
      const kept = await acquire(jar, { vendor_id: shop, document_id: invoice, order_line_id: orderLine, price: "3.00", currency: "CAD" });

      await fails(`update ${TABLE} set price = 1 where id = $1`, [kept.id], /permission denied/);
      await fails(`delete from ${TABLE} where id = $1`, [kept.id], /permission denied/);
      // What a record cites cannot be taken out from under it.
      await fails(`delete from inventory_documents where id = $1`, [invoice], /inventory_container_acquisitions_document/);
      await fails(`delete from inventory_orders where id = $1`, [order], /inventory_container_acquisitions_order_line/);
      const onlyHere = await seller("Seller of one jar");
      await acquire(await container(await lot(p)), { vendor_id: onlyHere });
      await fails(`delete from inventory_businesses where id = $1`, [onlyHere], /inventory_container_acquisitions_vendor/);
      await fails(`delete from inventory_containers where id = $1`, [jar], /inventory_container_acquisitions_container/);

      await asOwner();
      await fails(`update ${TABLE} set price = 1 where id = $1`, [kept.id], /kept as it was written/);
      await fails(`delete from ${TABLE} where id = $1`, [kept.id], /kept as it was written/);
      expect(num((await one(`select price from ${TABLE} where id = $1`, [kept.id])).price)).toBe(3);
    });
  });

  test("recording, retrying or reusing a purchase record never adds stock", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const l = await lot(await product("Unchanged powder"));
      const [jar1, jar2] = [await container(l), await container(l)];
      await opening(jar1);
      const movements = async () => num((await one(`select count(*) from inventory_movements`)).count);
      const before = { moves: await movements(), jar1: await balanceOf(jar1), jar2: await balanceOf(jar2) };
      expect(before.jar1).toEqual({ balance: 250, basis: "labelled_unopened" });

      const invoice = await paper(org, user);
      await attach(invoice, jar1);
      const key = `acquisition:${jar1}:${randomUUID()}`;
      await acquire(jar1, { document_id: invoice, price: "18.50", currency: "CAD", idempotency_key: key });
      // The retry finds the first and adds nothing.
      const [text, params] = record(jar1, { document_id: invoice, price: "18.50", currency: "CAD", idempotency_key: key });
      expect(await q(text.replace(" returning *", " on conflict (organization_id, idempotency_key) do nothing returning *"), params)).toEqual([]);
      // A key is used once in the business, whichever jar a replay names.
      await fails(...record(jar2, { note: "replayed", idempotency_key: key }), /inventory_container_acquisitions_once/);
      // The same old invoice, attached to a second jar.
      await attach(invoice, jar2);
      await acquire(jar2, { document_id: invoice });

      expect(await movements()).toBe(before.moves);
      expect(await balanceOf(jar1)).toEqual(before.jar1);
      expect(await balanceOf(jar2)).toEqual(before.jar2);
      expect(num((await one(`select count(*) from ${TABLE} where container_id = $1`, [jar1])).count)).toBe(1);
    });
  });
});

describe("0049 isolation", () => {
  test("another business cannot see, cite, correct or write purchase records of this one", async () => {
    await inRollback(async () => {
      const paolo = await business("Owner of the jars");
      const other = await business("Unrelated business");

      await asApp(paolo.org, paolo.user);
      const p = await product("Private powder");
      const jar = await container(await lot(p));
      const shop = await seller("Private shop");
      const invoice = await paper(paolo.org, paolo.user);
      await attach(invoice, jar);
      const order = (await one(`insert into inventory_orders (organization_id, vendor_id) values (${ORG}, $1) returning id`, [shop])).id;
      const orderLine = (await one(
        `insert into inventory_order_lines (organization_id, order_id, description, packages) values (${ORG}, $1, 'Private', 1) returning id`,
        [order],
      )).id;
      const theirs = await acquire(jar, { vendor_id: shop, document_id: invoice, price: "40.00", currency: "CAD" });

      await asApp(other.org, other.user);
      await q(`select set_config('app.is_staff', 'on', true)`);
      expect(await q(`select id from ${TABLE}`)).toEqual([]);
      const mine = await container(await lot(await product("Own powder")));

      await fails(...record(jar, { note: "Their jar" }), /inventory_container_acquisitions_container/);
      await fails(...record(mine, { vendor_id: shop }), /inventory_container_acquisitions_vendor/);
      await fails(...record(mine, { document_id: invoice }), /inventory_container_acquisitions_document/);
      await fails(...record(mine, { order_line_id: orderLine }), /inventory_container_acquisitions_order_line/);
      await fails(...record(mine, { supersedes_id: theirs.id, note: "Hijack" }), /earlier record of the same container/);
      await fails(
        `insert into ${TABLE} (organization_id, container_id, note) values ($1, $2, 'Smuggled')`,
        [paolo.org, jar],
        /row-level security/,
      );

      await q(`select set_config('app.org_id', '', true)`);
      expect(await q(`select id from ${TABLE}`)).toEqual([]);

      await asApp(paolo.org, paolo.user);
      expect((await current(jar)).map((r) => r.id)).toEqual([theirs.id]);
    });
  });
});
