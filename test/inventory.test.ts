import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";

/**
 * Inventory (0048), proved against the RESTRICTED role.
 *
 * Every test runs in one transaction that is rolled back, so nothing here
 * touches the shared seed fixtures. Fixtures that only the owner may create (a
 * company, an account, a membership) are made as the owner; everything a
 * business does with its inventory is done after `set local role portal_app`
 * and a transaction-local app.org_id, exactly as the portal's
 * inTenantTransaction() does it. A test that passed as the owner would prove
 * nothing: the owner is exempt from row-level security.
 *
 * Test names carry the acceptance scenario they cover (A02-A12 of the
 * infrastructure requirements). The data is synthetic and belongs to nobody.
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

/** A business (tenant) with one owner who is a person. Made as the database owner. */
async function business(name = "Inventory test") {
  const t = tag();
  const org = (await one(
    `insert into organizations (type, name, slug) values ('client', $1, $2) returning id`,
    [`${name} ${t}`, `inventory-test-${t}`],
  )).id as string;
  const user = (await one(
    `insert into users (email, full_name) values ($1, $2) returning id`,
    [`inventory-${t}@example.test`, `Inventory ${t}`],
  )).id as string;
  await q(`insert into memberships (user_id, organization_id, role) values ($1, $2, 'owner')`, [user, org]);
  return { org, user };
}

/** Act as the portal: the restricted role, scoped to one business (and person). */
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

async function material(name: string, specification: string | null = null) {
  return (await one(
    `insert into inventory_materials (organization_id, name, specification) values (${ORG}, $1, $2) returning id`,
    [name, specification],
  )).id as string;
}

/** A single-material product: 100 g of it is 100 g of the material. */
async function product(name: string, materialId: string | null, packageGrams: number | null = null) {
  const id = (await one(
    `insert into inventory_products (organization_id, name, composition, package_quantity, package_unit)
     values (${ORG}, $1, $2, $3, $4) returning id`,
    [name, materialId ? "single" : "unknown", packageGrams, packageGrams === null ? null : "g"],
  )).id as string;
  if (materialId) {
    await q(
      `insert into inventory_product_components (organization_id, product_id, material_id, quantity, unit, per_quantity, per_unit)
       values (${ORG}, $1, $2, 100, 'g', 100, 'g')`,
      [id, materialId],
    );
  }
  return id;
}

async function lot(productId: string, extra: { expiry?: string; hold?: string } = {}) {
  return (await one(
    `insert into inventory_lots (organization_id, product_id, expiry_kind, expiry_date, hold, hold_reason)
     values (${ORG}, $1, $2, $3, $4, $5) returning id`,
    [
      productId,
      extra.expiry ? "best_before" : null,
      extra.expiry ?? null,
      extra.hold ?? "none",
      extra.hold && extra.hold !== "none" ? "test hold" : null,
    ],
  )).id as string;
}

async function container(lotId: string, status = "sealed", nominalGrams: number | null = null) {
  return (await one(
    `insert into inventory_containers (organization_id, lot_id, status, nominal_quantity, nominal_unit)
     values (${ORG}, $1, $2, $3, $4) returning id`,
    [lotId, status, nominalGrams, nominalGrams === null ? null : "g"],
  )).id as string;
}

async function move(
  containerId: string,
  kind: string,
  quantity: number | null,
  basis: string | null,
  extra: Record<string, unknown> = {},
) {
  const cols = ["organization_id", "container_id", "kind", "quantity", "unit", "basis"];
  const vals: unknown[] = [containerId, kind, quantity, quantity === null ? null : "g", basis];
  for (const [k, v] of Object.entries(extra)) {
    cols.push(k);
    vals.push(v);
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
  return (await one(
    `insert into inventory_movements (${cols.join(", ")}) values (${ORG}, ${placeholders}) returning id`,
    vals,
  )).id as string;
}

async function balanceOf(containerId: string) {
  const row = await one(
    `select balance, balance_basis from inventory_container_balances where container_id = $1`,
    [containerId],
  );
  return { balance: num(row.balance), basis: row.balance_basis as string };
}

/** A company listed through the shared directory, and this business's relationship with it. */
async function vendor(name: string, roles: { manufacturer?: boolean } = {}) {
  const listed = await one(`select company_id, company_code from list_company($1)`, [name]);
  const businessId = (await one(
    `insert into inventory_businesses (organization_id, company_id, is_vendor, is_manufacturer)
     values (${ORG}, $1, true, $2) returning id`,
    [listed.company_id, roles.manufacturer ?? false],
  )).id as string;
  return { businessId, companyId: listed.company_id as string, code: listed.company_code as string };
}

const INVENTORY_TABLES = [
  "inventory_nutrients", "inventory_materials", "inventory_material_aliases", "inventory_businesses",
  "inventory_brands", "inventory_formulations", "inventory_products", "inventory_product_components",
  "inventory_offers", "inventory_sourcing_preferences", "inventory_orders", "inventory_order_lines",
  "inventory_receipts", "inventory_receipt_lines", "inventory_locations", "inventory_lots",
  "inventory_containers", "inventory_captures", "inventory_documents", "inventory_document_links",
  "inventory_extractions", "inventory_extracted_fields", "inventory_match_candidates", "inventory_measurements",
  "inventory_product_nutrients", "inventory_product_claims", "inventory_offer_prices",
  "inventory_formulation_versions", "inventory_formulation_lines", "inventory_batch_plans",
  "inventory_reservations", "inventory_batches", "inventory_movements", "inventory_notes",
  "inventory_purchase_intents",
];

describe("A12 migration", () => {
  test("0048 is re-runnable: applying it twice changes nothing", async () => {
    const sql = await readFile("drizzle/0048_inventory.sql", "utf8");
    await inRollback(async () => {
      const before = await one(`select count(*)::int as n from inventory_units`);
      await owner.query(sql);
      await owner.query(sql);
      expect((await one(`select count(*)::int as n from inventory_units`)).n).toBe(before.n);
      const tables = await q(
        `select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename = any($1)`,
        [INVENTORY_TABLES],
      );
      expect(tables).toHaveLength(INVENTORY_TABLES.length);
      expect(tables.every((t) => t.rowsecurity)).toBe(true);
    });
  });

  test("every inventory table has exactly the tenant policy, and no staff policy", async () => {
    const policies = await q(
      `select tablename, policyname, roles::text as roles from pg_policies
        where schemaname = 'public' and tablename = any($1)`,
      [INVENTORY_TABLES],
    );
    expect(policies).toHaveLength(INVENTORY_TABLES.length);
    for (const p of policies) {
      expect(p.policyname).toBe(`${p.tablename}_tenant_isolation`);
      expect(p.roles).toBe("{portal_app}");
    }
  });

  test("the views run with the caller's rights", async () => {
    const views = await q(
      `select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'inventory_%'`,
    );
    expect(views.map((v) => v.relname).sort()).toEqual([
      "inventory_business_directory",
      "inventory_container_balances",
      "inventory_order_line_status",
      "inventory_plan_requirements",
      "inventory_purchase_options",
    ]);
    for (const v of views) expect(v.reloptions).toContain("security_invoker=true");
  });

  test("0054's plain tables to read by run with the caller's rights and grant nothing", async () => {
    const views = await q(
      `select c.relname, c.reloptions,
              has_table_privilege('portal_app', c.oid, 'select') as app_reads
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'my\\_%'`,
    );
    expect(views.map((v) => v.relname).sort()).toEqual(["my_inventory", "my_products", "my_purchases"]);
    for (const v of views) {
      expect(v.reloptions).toContain("security_invoker=true");
      expect(v.app_reads).toBe(false);
    }
    // They read: each answers a plain select.
    for (const v of views) await q(`select * from ${v.relname} limit 1`);
  });
});

describe("A02-A04 catalogue, opening stock and weighing", () => {
  test("A02 an opened 500 g package with unknown remaining weight is listed as unknown, not 500 g", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const m = await material("Opened powder");
      const p = await product("Opened powder 500 g", m, 500);
      const c = await container(await lot(p), "open", 500);

      await fails(
        `insert into inventory_movements (organization_id, container_id, kind, quantity, unit, basis)
         values (${ORG}, $1, 'opening', 500, 'g', 'labelled_unopened')`,
        [c],
        /opened package is not still its label weight/,
      );
      await move(c, "opening", null, "unknown");

      expect(await balanceOf(c)).toEqual({ balance: null, basis: "unknown" });
      const listed = await one(
        `select nominal_quantity, nominal_unit from inventory_container_balances where container_id = $1`,
        [c],
      );
      expect([num(listed.nominal_quantity), listed.nominal_unit]).toEqual([500, "g"]);
    });
  });

  test("A02 a container with no stock event at all is unknown, never zero", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const c = await container(await lot(await product("Uncounted", await material("Uncounted"))));
      expect(await balanceOf(c)).toEqual({ balance: null, basis: "unknown" });
      // Changes recorded against an unknown amount leave it unknown.
      await move(c, "loss", -10, "estimated", { note: "spilled" });
      expect(await balanceOf(c)).toEqual({ balance: null, basis: "unknown" });
    });
  });

  test("A03 retrying a confirmation creates one event; a second identical jar stays a second container", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const m = await material("Jarred powder");
      const p = await product("Jarred powder 250 g", m, 250);
      const sharedLot = await lot(p);

      // Capture 1 is confirmed once, as a new sealed container with its label weight.
      const capture1 = (await one(
        `insert into inventory_captures (organization_id, created_by) values (${ORG}, $1) returning id`,
        [user],
      )).id;
      const jar1 = await container(sharedLot, "sealed", 250);
      await q(
        `update inventory_captures set status = 'confirmed', container_id = $2, outcome = 'new_container',
                confirmed_by = $3, confirmed_at = now() where id = $1 and status = 'open'`,
        [capture1, jar1, user],
      );
      const key = `capture:${capture1}:opening`;
      await move(jar1, "opening", 250, "labelled_unopened", { capture_id: capture1, idempotency_key: key });

      // The retry: same confirmation, same key. It finds the first attempt instead.
      const retried = await q(
        `insert into inventory_movements (organization_id, container_id, kind, quantity, unit, basis, capture_id, idempotency_key)
         values (${ORG}, $1, 'opening', 250, 'g', 'labelled_unopened', $2, $3)
         on conflict (organization_id, idempotency_key) do nothing returning id`,
        [jar1, capture1, key],
      );
      expect(retried).toHaveLength(0);
      // Even under a different key, a container is opened once.
      await fails(
        `insert into inventory_movements (organization_id, container_id, kind, quantity, unit, basis)
         values (${ORG}, $1, 'opening', 250, 'g', 'labelled_unopened')`,
        [jar1],
        /inventory_movements_one_opening/,
      );
      // And a confirmed capture cannot be re-pointed at another container.
      const elsewhere = await container(sharedLot, "sealed", 250);
      await fails(
        `update inventory_captures set container_id = $2 where id = $1`,
        [capture1, elsewhere],
        /confirmed capture is final/,
      );

      // A deliberately added second identical jar: same lot, its own container and event.
      const capture2 = (await one(
        `insert into inventory_captures (organization_id, created_by) values (${ORG}, $1) returning id`,
        [user],
      )).id;
      const jar2 = await container(sharedLot, "sealed", 250);
      await q(
        `update inventory_captures set status = 'confirmed', container_id = $2, outcome = 'new_container',
                confirmed_by = $3, confirmed_at = now() where id = $1`,
        [capture2, jar2, user],
      );
      await move(jar2, "opening", 250, "labelled_unopened", { capture_id: capture2, idempotency_key: `capture:${capture2}:opening` });

      const rows = await q(
        `select container_id, balance from inventory_container_balances where lot_id = $1 and balance is not null`,
        [sharedLot],
      );
      expect(rows.map((r) => num(r.balance))).toEqual([250, 250]);
      expect(new Set(rows.map((r) => r.container_id)).size).toBe(2);
      const openings = await one(
        `select count(*)::int as n from inventory_movements where kind = 'opening' and container_id = any($1)`,
        [[jar1, jar2]],
      );
      expect(openings.n).toBe(2);
    });
  });

  test("A04 gross 330 g and tare 30 g is 300 g net; a missing tare stays unknown; a correction applies once", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const c = await container(await lot(await product("Weighed powder", await material("Weighed powder"))), "open");
      await move(c, "opening", null, "unknown");

      // Net must be the difference, never the gross.
      await fails(
        `insert into inventory_measurements (organization_id, container_id, gross_g, tare_g, tare_basis, net_g, method, confidence)
         values (${ORG}, $1, 330, 30, 'measured', 330, 'scale', 'exact')`,
        [c],
        /inventory_measurements_net_is_difference/,
      );
      // Without a tare, the gross cannot be taken as the contents.
      await fails(
        `insert into inventory_measurements (organization_id, container_id, gross_g, net_g, method, confidence)
         values (${ORG}, $1, 330, 330, 'scale', 'estimated')`,
        [c],
        /inventory_measurements_gross_is_not_net/,
      );
      const noTare = (await one(
        `insert into inventory_measurements (organization_id, container_id, gross_g, method, confidence)
         values (${ORG}, $1, 330, 'scale', 'exact') returning id, net_g`,
        [c],
      ));
      expect(noTare.net_g).toBeNull();
      await fails(
        `insert into inventory_movements (organization_id, container_id, kind, quantity, unit, basis, measurement_id)
         values (${ORG}, $1, 'count', 330, 'g', 'measured', $2)`,
        [c, noTare.id],
        /has no net amount/,
      );
      expect(await balanceOf(c)).toEqual({ balance: null, basis: "unknown" });

      const weighing = (await one(
        `insert into inventory_measurements (organization_id, container_id, gross_g, tare_g, tare_basis, net_g, method, confidence)
         values (${ORG}, $1, 330, 30, 'measured', 300, 'scale', 'exact') returning id`,
        [c],
      )).id;
      await fails(
        `insert into inventory_movements (organization_id, container_id, kind, quantity, unit, basis, measurement_id)
         values (${ORG}, $1, 'count', 330, 'g', 'measured', $2)`,
        [c, weighing],
        /must be the weighing's net/,
      );
      const counted = await move(c, "count", 300, "measured", { measurement_id: weighing, idempotency_key: `weigh:${weighing}` });
      expect(await balanceOf(c)).toEqual({ balance: 300, basis: "measured" });

      // Correction: a reason is required, and the balance changes once.
      await fails(
        `insert into inventory_movements (organization_id, container_id, kind, reverses_id) values (${ORG}, $1, 'reversal', $2)`,
        [c, counted],
        /inventory_movements_reason/,
      );
      await move(c, "reversal", null, null, { reverses_id: counted, note: "wrong jar on the scale" });
      const reweigh = (await one(
        `insert into inventory_measurements (organization_id, container_id, gross_g, tare_g, tare_basis, net_g, method, confidence)
         values (${ORG}, $1, 320, 30, 'measured', 290, 'scale', 'exact') returning id`,
        [c],
      )).id;
      await move(c, "count", 290, "measured", { measurement_id: reweigh, note: "re-weighed after correction" });
      expect(await balanceOf(c)).toEqual({ balance: 290, basis: "measured" });
      // Use in production must name its batch; refused, and nothing changes.
      await fails(
        `insert into inventory_movements (organization_id, container_id, kind, quantity, unit, basis)
         values (${ORG}, $1, 'production_use', -40, 'g', 'calculated')`,
        [c],
        /inventory_movements_sources/,
      );
      expect(await balanceOf(c)).toEqual({ balance: 290, basis: "measured" });
      await fails(
        `insert into inventory_movements (organization_id, container_id, kind, reverses_id, note) values (${ORG}, $1, 'reversal', $2, 'again')`,
        [c, counted],
        /inventory_movements_reversed_once/,
      );
    });
  });

  test("the ledger is append-only for the application", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const c = await container(await lot(await product("Ledger powder", await material("Ledger powder"))), "sealed", 100);
      const id = await move(c, "opening", 100, "labelled_unopened");
      await fails(`update inventory_movements set quantity = 1000 where id = $1`, [id], /permission denied/);
      await fails(`delete from inventory_movements where id = $1`, [id], /permission denied/);
      expect(await balanceOf(c)).toEqual({ balance: 100, basis: "labelled_unopened" });
    });
  });
});

describe("A05 company identity", () => {
  test("one company is vendor and manufacturer under one iD; a separate seller has another; nobody gets a login", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);

      const maker = await vendor("Maker and seller", { manufacturer: true });
      const seller = await vendor("Separate seller");
      expect(maker.code).toMatch(/^10X-[0-9A-HJKMNP-TV-Z]{5}$/);
      expect(seller.code).toMatch(/^10X-[0-9A-HJKMNP-TV-Z]{5}$/);
      expect(seller.code).not.toBe(maker.code);
      expect(seller.companyId).not.toBe(maker.companyId);

      const directory = await q(
        `select company_id, id_code, is_vendor, is_manufacturer, company_type from inventory_business_directory order by name`,
      );
      expect(directory).toEqual([
        { company_id: maker.companyId, id_code: maker.code, is_vendor: true, is_manufacturer: true, company_type: "listed" },
        { company_id: seller.companyId, id_code: seller.code, is_vendor: true, is_manufacturer: false, company_type: "listed" },
      ]);
      // A company is one row in a business's relationships, whatever its roles.
      await fails(
        `insert into inventory_businesses (organization_id, company_id, is_supplier) values (${ORG}, $1, true)`,
        [maker.companyId],
        /inventory_businesses_once/,
      );
      // Issuing again returns the same live iD.
      expect((await one(`select issue_company_id($1) as code`, [maker.companyId])).code).toBe(maker.code);

      // The application cannot retire or move a company's iD, or issue one to a client.
      await fails(
        `update identities set revoked_at = now() where organization_id = $1`,
        [maker.companyId],
        /Only an operator changes a company's iD/,
      );
      await fails(
        `insert into identities (organization_id, id_code) values ($1, 'ZZZ-TEST')`,
        [org],
        /Only an operator issues an iD to a client or house company/,
      );

      // An order keeps the vendor's iD as it was, as paperwork.
      const order = (await one(
        `insert into inventory_orders (organization_id, vendor_id, order_number) values (${ORG}, $1, 'A05-1') returning id, vendor_code`,
        [maker.businessId],
      ));
      expect(order.vendor_code).toBe(maker.code);

      // Reissue is an operator's act, and moves nothing.
      await asOwner();
      const reissued = (await one(`select reissue_company_id($1) as code`, [maker.companyId])).code;
      expect(reissued).not.toBe(maker.code);
      const history = await q(
        `select id_code, revoked_at is not null as revoked from identities where organization_id = $1 order by issued_at, id_code`,
        [maker.companyId],
      );
      expect(history.filter((h) => !h.revoked).map((h) => h.id_code)).toEqual([reissued]);
      expect(history.filter((h) => h.revoked).map((h) => h.id_code)).toEqual([maker.code]);
      // The old code is never handed to anyone else, even a company holding no iD.
      const blank = (await one(
        `insert into organizations (type, name, slug) values ('listed', 'Blank company', $1) returning id`,
        [`blank-company-${tag()}`],
      )).id;
      await fails(`insert into identities (organization_id, id_code) values ($1, $2)`, [blank, maker.code], /identities_id_code_unique/);

      await asApp(org, user);
      const after = await one(
        `select o.vendor_id, o.vendor_code, b.company_id from inventory_orders o
           join inventory_businesses b on b.id = o.vendor_id where o.id = $1`,
        [order.id],
      );
      expect(after).toEqual({ vendor_id: maker.businessId, vendor_code: maker.code, company_id: maker.companyId });
      expect((await one(`select id_code from inventory_business_directory where company_id = $1`, [maker.companyId])).id_code).toBe(reissued);

      // Identification only: no account, membership or invitation exists or can be made.
      await asOwner();
      for (const company of [maker.companyId, seller.companyId]) {
        expect((await one(`select count(*)::int as n from memberships where organization_id = $1`, [company])).n).toBe(0);
        expect((await one(`select count(*)::int as n from invitations where organization_id = $1`, [company])).n).toBe(0);
        expect((await one(`select count(*)::int as n from identities where organization_id = $1 and user_id is not null`, [company])).n).toBe(0);
      }
      await fails(
        `insert into memberships (user_id, organization_id, role) values ($1, $2, 'owner')`,
        [user, maker.companyId],
        /listed company has no members or invitations/,
      );
    });
  });
});

describe("A06 isolation", () => {
  test("an unrelated business cannot read, write or link another's inventory, documents or extraction results", async () => {
    await inRollback(async () => {
      const paolo = await business("Owner of the stock");
      const other = await business("Unrelated business");

      await asApp(paolo.org, paolo.user);
      const m = await material("Private powder");
      const brand = (await one(`insert into inventory_brands (organization_id, name) values (${ORG}, 'Private brand') returning id`)).id;
      const p = await product("Private powder 1 kg", m, 1000);
      const c = await container(await lot(p), "sealed", 1000);
      await move(c, "opening", 1000, "labelled_unopened");
      const capture = (await one(`insert into inventory_captures (organization_id, created_by) values (${ORG}, $1) returning id`, [paolo.user])).id;
      const doc = (await one(
        `insert into inventory_documents (organization_id, capture_id, kind, content_type, storage_key, byte_size, sha256, uploaded_by, state)
         values (${ORG}, $1, 'photo', 'image/jpeg', $2, 1234, $3, $4, 'stored') returning id`,
        [capture, `inventory/${paolo.org}/${randomBytes(24).toString("base64url")}.jpg`, randomBytes(32), paolo.user],
      )).id;
      const extraction = (await one(
        `insert into inventory_extractions (organization_id, capture_id, engine, status) values (${ORG}, $1, 'fixture: test', 'needs_review') returning id`,
        [capture],
      )).id;
      await q(
        `insert into inventory_extracted_fields (organization_id, extraction_id, document_id, field, raw_text, confidence)
         values (${ORG}, $1, $2, 'product_name', 'Private powder', 0.9)`,
        [extraction, doc],
      );
      // A key naming another business is refused outright.
      await fails(
        `insert into inventory_documents (organization_id, kind, content_type, storage_key, byte_size, sha256, uploaded_by)
         values (${ORG}, 'photo', 'image/jpeg', $1, 10, $2, $3)`,
        [`inventory/${other.org}/${randomBytes(24).toString("base64url")}.jpg`, randomBytes(32), paolo.user],
        /inventory_documents_key_is_own/,
      );

      // The other business — even with the staff flag on — sees none of it.
      await asApp(other.org, other.user);
      await q(`select set_config('app.is_staff', 'on', true)`);
      for (const [table, id] of [
        ["inventory_materials", m], ["inventory_brands", brand], ["inventory_products", p],
        ["inventory_containers", c], ["inventory_captures", capture], ["inventory_documents", doc],
        ["inventory_extractions", extraction],
      ] as const) {
        expect((await q(`select id from ${table} where id = $1`, [id])).length, table).toBe(0);
        expect((await q(`update ${table} set organization_id = organization_id where id = $1 returning id`, [id])).length, table).toBe(0);
        expect((await q(`delete from ${table} where id = $1 returning id`, [id])).length, table).toBe(0);
      }
      expect(await q(`select * from inventory_extracted_fields`)).toEqual([]);
      expect(await q(`select * from inventory_movements where container_id = $1`, [c])).toEqual([]);
      expect(await q(`select * from inventory_container_balances where container_id = $1`, [c])).toEqual([]);
      expect(await q(`select * from inventory_plan_requirements`)).toEqual([]);

      // It cannot write into the first business, nor link to its rows by uuid.
      await fails(
        `insert into inventory_materials (organization_id, name) values ($1, 'Smuggled')`,
        [paolo.org],
        /row-level security/,
      );
      await fails(
        `insert into inventory_products (organization_id, name, brand_id) values (${ORG}, 'Copycat', $1)`,
        [brand],
        /inventory_products_brand/,
      );
      await fails(
        `insert into inventory_movements (organization_id, container_id, kind, quantity, unit, basis)
         values (${ORG}, $1, 'count', 0, 'g', 'estimated')`,
        [c],
        /inventory_movements_container/,
      );
      await fails(
        `insert into inventory_document_links (organization_id, document_id, product_id) values (${ORG}, $1, $2)`,
        [doc, p],
        /inventory_document_links_document/,
      );

      // With no scope at all, nothing is visible.
      await q(`select set_config('app.org_id', '', true)`);
      expect(await q(`select id from inventory_products`)).toEqual([]);
    });
  });
});

describe("A07 compatibility", () => {
  test("coconut milk and coconut water powders never merge or substitute; a premix can stay unknown", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const milk = await material("Coconut milk powder");
      const water = await material("Coconut water powder");
      expect(milk).not.toBe(water);
      await q(`insert into inventory_material_aliases (organization_id, material_id, alias) values (${ORG}, $1, 'coconut powder')`, [milk]);
      await fails(
        `insert into inventory_material_aliases (organization_id, material_id, alias) values (${ORG}, $1, 'Coconut Powder')`,
        [water],
        /inventory_material_aliases_unique/,
      );
      // Same name, different specification: two materials.
      await material("Beet root", "whole powder");
      await material("Beet root", "extract, low oxalate");
      await fails(
        `insert into inventory_materials (organization_id, name, specification) values (${ORG}, 'beet root', 'WHOLE POWDER')`,
        [],
        /inventory_materials_name_unique/,
      );

      // A premix catalogued as itself: its contents named, amounts not invented.
      const premix = (await one(
        `insert into inventory_products (organization_id, name, composition) values (${ORG}, 'Fibre premix', 'unknown') returning id`,
      )).id;
      await q(
        `insert into inventory_product_components (organization_id, product_id, material_id) values (${ORG}, $1, $2)`,
        [premix, milk],
      );
      const premixJar = await container(await lot(premix), "sealed", 500);
      await move(premixJar, "opening", 500, "labelled_unopened");

      // A coconut WATER product cannot be ranked as a source of coconut MILK powder.
      const waterProduct = await product("Coconut water powder 250 g", water, 250);
      const seller = await vendor("Coconut seller");
      const waterOffer = (await one(
        `insert into inventory_offers (organization_id, vendor_id, product_id, package_quantity, package_unit, stock_status)
         values (${ORG}, $1, $2, 250, 'g', 'in_stock') returning id`,
        [seller.businessId, waterProduct],
      )).id;
      await fails(
        `insert into inventory_sourcing_preferences (organization_id, material_id, rank, vendor_id, offer_id)
         values (${ORG}, $1, 1, $2, $3)`,
        [milk, seller.businessId, waterOffer],
        /not recorded as containing this material/,
      );
      const waterJar = await container(await lot(waterProduct), "sealed", 250);
      await move(waterJar, "opening", 250, "labelled_unopened");

      // A plan needing coconut milk powder finds no supply in either jar.
      const f = (await one(`insert into inventory_formulations (organization_id, name) values (${ORG}, 'Milk test') returning id`)).id;
      const v = (await one(
        `insert into inventory_formulation_versions (organization_id, formulation_id, label) values (${ORG}, $1, 'v1') returning id`,
        [f],
      )).id;
      await q(`insert into inventory_formulation_lines (organization_id, version_id, material_id, quantity, unit) values (${ORG}, $1, $2, 3, 'g')`, [v, milk]);
      await q(`update inventory_formulation_versions set status = 'active' where id = $1`, [v]);
      await q(`insert into inventory_batch_plans (organization_id, version_id, planned_for, servings) values (${ORG}, $1, current_date + 14, 10)`, [v]);
      const need = await one(`select required, usable_stock, shortfall from inventory_plan_requirements where material_id = $1`, [milk]);
      expect([num(need.required), num(need.usable_stock), num(need.shortfall)]).toEqual([30, 0, 30]);
    });
  });
});

/** Two plans for one material on one date: 200 g and 150 g. 220 g in stock. */
async function planningFixture(user: string) {
  const m = await material("Planned powder");
  const p = await product("Planned powder bulk", m, 1000);
  const stock = await container(await lot(p), "sealed", 220);
  await move(stock, "opening", 220, "labelled_unopened");

  const f = (await one(`insert into inventory_formulations (organization_id, name) values (${ORG}, 'Planned blend') returning id`)).id;
  const v = (await one(
    `insert into inventory_formulation_versions (organization_id, formulation_id, label, serving_quantity, serving_unit)
     values (${ORG}, $1, 'v1', 1, 'g') returning id`,
    [f],
  )).id;
  await q(`insert into inventory_formulation_lines (organization_id, version_id, material_id, quantity, unit) values (${ORG}, $1, $2, 1, 'g')`, [v, m]);
  await q(`update inventory_formulation_versions set status = 'active' where id = $1`, [v]);

  const plan200 = (await one(
    `insert into inventory_batch_plans (organization_id, version_id, planned_for, servings, created_by)
     values (${ORG}, $1, current_date + 14, 200, $2) returning id`,
    [v, user],
  )).id;
  const plan150 = (await one(
    `insert into inventory_batch_plans (organization_id, version_id, planned_for, servings, created_by)
     values (${ORG}, $1, current_date + 14, 150, $2) returning id`,
    [v, user],
  )).id;

  // 50 g on order, due the day before the plans.
  const supplier = await vendor("Planning vendor");
  const order = (await one(
    `insert into inventory_orders (organization_id, vendor_id, order_number, expected_on, status)
     values (${ORG}, $1, $2, current_date + 13, 'placed') returning id`,
    [supplier.businessId, `PLAN-${tag()}`],
  )).id;
  await q(
    `insert into inventory_order_lines (organization_id, order_id, description, product_id, packages, package_quantity, package_unit)
     values (${ORG}, $1, 'Planned powder 50 g', $2, 1, 50, 'g')`,
    [order, p],
  );
  return { m, p, stock, v, plan200, plan150, order, supplier };
}

async function totalShortfall(materialId: string) {
  return num((await one(
    `select coalesce(sum(shortfall), 0) as s from inventory_plan_requirements where material_id = $1`,
    [materialId],
  )).s);
}

describe("A08-A10 replenishment", () => {
  test("A08 200 g + 150 g against 220 g in stock and 50 g arriving in time is 80 g short; a reservation is not subtracted twice", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const fx = await planningFixture(user);

      const rows = await q(
        `select plan_id, required, usable_stock, arriving_in_time, shortfall from inventory_plan_requirements
          where material_id = $1 order by needed_first_by_earlier_plans`,
        [fx.m],
      );
      expect(rows.map((r) => num(r.required)).sort((a, b) => a! - b!)).toEqual([150, 200]);
      expect(rows.every((r) => num(r.usable_stock) === 220 && num(r.arriving_in_time) === 50)).toBe(true);
      expect(await totalShortfall(fx.m)).toBe(80);

      // Set 200 g aside for the 200 g plan: it counts toward that plan, and is gone for the other.
      await q(
        `insert into inventory_reservations (organization_id, plan_id, container_id, material_id, quantity, unit, created_by)
         values (${ORG}, $1, $2, $3, 200, 'g', $4)`,
        [fx.plan200, fx.stock, fx.m, user],
      );
      expect(await totalShortfall(fx.m)).toBe(80);
      const reserved = await one(
        `select reserved_for_plan, shortfall from inventory_plan_requirements where plan_id = $1`,
        [fx.plan200],
      );
      expect([num(reserved.reserved_for_plan), num(reserved.shortfall)]).toEqual([200, 0]);

      // Saving a plan consumed nothing.
      expect(await balanceOf(fx.stock)).toEqual({ balance: 220, basis: "labelled_unopened" });

      // Once a batch is recorded for a plan, its demand is the ledger's, not the plan's: counted once.
      await q(
        `insert into inventory_batches (organization_id, version_id, plan_id, made_on) values (${ORG}, $1, $2, current_date)`,
        [fx.v, fx.plan200],
      );
      expect((await q(`select plan_id from inventory_plan_requirements where material_id = $1`, [fx.m])).map((r) => r.plan_id)).toEqual([fx.plan150]);
    });
  });

  test("A09 a late delivery leaves 130 g short; unknown and expired stock never count as supply", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const fx = await planningFixture(user);

      await q(`update inventory_orders set expected_on = current_date + 15 where id = $1`, [fx.order]);
      expect(await totalShortfall(fx.m)).toBe(130);
      await q(`update inventory_orders set expected_on = null where id = $1`, [fx.order]);
      expect(await totalShortfall(fx.m)).toBe(130);

      // A jar of unknown amount is something to check, not supply.
      const unknownJar = await container(await lot(fx.p), "open", 1000);
      await move(unknownJar, "opening", null, "unknown");
      // Expired by the plan date, or on hold: never usable.
      const expiredJar = await container(await lot(fx.p, { expiry: new Date(Date.now() + 5 * 86400e3).toISOString().slice(0, 10) }), "sealed", 100);
      await move(expiredJar, "opening", 100, "labelled_unopened");
      const heldJar = await container(await lot(fx.p, { hold: "review" }), "sealed", 100);
      await move(heldJar, "opening", 100, "labelled_unopened");

      expect(await totalShortfall(fx.m)).toBe(130);
      const verify = await q(`select containers_to_verify from inventory_plan_requirements where material_id = $1`, [fx.m]);
      expect(verify.map((r) => num(r.containers_to_verify))).toEqual([1, 1]);
    });
  });

  test("A10 preferred offer out of stock: the compatible alternative's 100 g pack covers 80 g with 20 g excess, dated and in CAD", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const fx = await planningFixture(user);
      expect(await totalShortfall(fx.m)).toBe(80);

      const preferred = await vendor("Preferred shop");
      const backup = await vendor("Backup shop");
      const preferredOffer = (await one(
        `insert into inventory_offers (organization_id, vendor_id, product_id, package_quantity, package_unit, price, currency, price_checked_at, stock_status, stock_checked_at)
         values (${ORG}, $1, $2, 250, 'g', 20.00, 'CAD', now(), 'out_of_stock', now()) returning id`,
        [preferred.businessId, fx.p],
      )).id;
      const backupOffer = (await one(
        `insert into inventory_offers (organization_id, vendor_id, product_id, package_quantity, package_unit, price, currency, price_checked_at, stock_status, stock_checked_at)
         values (${ORG}, $1, $2, 100, 'g', 9.99, 'CAD', '2026-10-18T12:00:00Z', 'in_stock', '2026-10-18T12:00:00Z') returning id`,
        [backup.businessId, fx.p],
      )).id;
      await q(
        `insert into inventory_sourcing_preferences (organization_id, material_id, rank, vendor_id, offer_id, reason)
         values (${ORG}, $1, 1, $2, $3, 'usual shop'), (${ORG}, $1, 2, $4, $5, 'backup')`,
        [fx.m, preferred.businessId, preferredOffer, backup.businessId, backupOffer],
      );

      const options = await q(
        `select offer_id, rank, packages, purchased, excess, price, currency, estimated_cost, stock_status, stock_checked_at, available, recommended
           from inventory_purchase_options where material_id = $1 order by rank`,
        [fx.m],
      );
      expect(options).toHaveLength(2);
      expect(options[0]).toMatchObject({ offer_id: preferredOffer, rank: 1, available: false, recommended: false, stock_status: "out_of_stock" });
      const pick = options[1];
      expect(pick).toMatchObject({ offer_id: backupOffer, rank: 2, available: true, recommended: true, currency: "CAD", stock_status: "in_stock" });
      expect([num(pick.packages), num(pick.purchased), num(pick.excess), num(pick.price), num(pick.estimated_cost)]).toEqual([1, 100, 20, 9.99, 9.99]);
      expect(new Date(pick.stock_checked_at).toISOString()).toBe("2026-10-18T12:00:00.000Z");
    });
  });
});

describe("A11 receiving", () => {
  test("500 g ordered, 200 g received: 200 g in stock, 300 g outstanding, and a retried receipt adds nothing", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const m = await material("Received powder");
      const p = await product("Received powder 100 g", m, 100);
      const seller = await vendor("Receiving vendor");
      const order = (await one(
        `insert into inventory_orders (organization_id, vendor_id, order_number, expected_on) values (${ORG}, $1, 'A11', current_date + 3) returning id`,
        [seller.businessId],
      )).id;
      const line = (await one(
        `insert into inventory_order_lines (organization_id, order_id, description, product_id, packages, package_quantity, package_unit)
         values (${ORG}, $1, 'Received powder 100 g x5', $2, 5, 100, 'g') returning id`,
        [order, p],
      )).id;

      const receipt = (await one(
        `insert into inventory_receipts (organization_id, order_id, received_by, idempotency_key) values (${ORG}, $1, $2, 'A11-delivery-1') returning id`,
        [order, user],
      )).id;
      const receiptLine = (await one(
        `insert into inventory_receipt_lines (organization_id, receipt_id, order_line_id, product_id, packages_accepted)
         values (${ORG}, $1, $2, $3, 2) returning id`,
        [receipt, line, p],
      )).id;
      const lotId = (await one(
        `insert into inventory_lots (organization_id, product_id, acquired_on, receipt_line_id) values (${ORG}, $1, current_date, $2) returning id`,
        [p, receiptLine],
      )).id;
      const bags = [await container(lotId, "sealed", 100), await container(lotId, "sealed", 100)];
      for (const [i, bag] of bags.entries()) {
        await move(bag, "receipt", 100, "labelled_unopened", { receipt_line_id: receiptLine, idempotency_key: `receipt-line:${receiptLine}:${i}` });
      }

      const status = await one(
        `select packages_received, packages_outstanding, quantity_outstanding, package_unit from inventory_order_line_status where order_line_id = $1`,
        [line],
      );
      expect([num(status.packages_received), num(status.packages_outstanding), num(status.quantity_outstanding), status.package_unit]).toEqual([2, 3, 300, "g"]);
      const stocked = await one(`select sum(balance) as g from inventory_container_balances where lot_id = $1`, [lotId]);
      expect(num(stocked.g)).toBe(200);

      // The retry: the same delivery, the same bags.
      await fails(
        `insert into inventory_receipts (organization_id, order_id, idempotency_key) values (${ORG}, $1, 'A11-delivery-1')`,
        [order],
        /inventory_receipts_once/,
      );
      await fails(
        `insert into inventory_movements (organization_id, container_id, kind, quantity, unit, basis, receipt_line_id)
         values (${ORG}, $1, 'receipt', 100, 'g', 'labelled_unopened', $2)`,
        [bags[0], receiptLine],
        /inventory_movements_one_receipt/,
      );
      expect(num((await one(`select sum(balance) as g from inventory_container_balances where lot_id = $1`, [lotId])).g)).toBe(200);
      // An order alone is never stock.
      expect((await q(`select 1 from inventory_container_balances where product_id = $1 and lot_id <> $2`, [p, lotId])).length).toBe(0);
    });
  });
});

describe("history and approvals", () => {
  test("a version is frozen once active, and a batch is only recorded from a frozen version", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const m = await material("Frozen powder");
      const f = (await one(`insert into inventory_formulations (organization_id, name) values (${ORG}, 'Frozen blend') returning id`)).id;
      const v = (await one(`insert into inventory_formulation_versions (organization_id, formulation_id, label) values (${ORG}, $1, 'v1') returning id`, [f])).id;
      const line = (await one(`insert into inventory_formulation_lines (organization_id, version_id, material_id, quantity, unit) values (${ORG}, $1, $2, 5, 'g') returning id`, [v, m])).id;
      await fails(`insert into inventory_batches (organization_id, version_id, made_on) values (${ORG}, $1, current_date)`, [v], /Activate the version/);
      await q(`update inventory_formulation_versions set status = 'active' where id = $1`, [v]);
      await fails(`update inventory_formulation_lines set quantity = 6 where id = $1`, [line], /frozen once it leaves draft/);
      await fails(`delete from inventory_formulation_lines where id = $1`, [line], /frozen once it leaves draft/);
      await fails(`update inventory_formulation_versions set status = 'draft' where id = $1`, [v], /cannot be reopened/);
      await fails(`delete from inventory_formulation_versions where id = $1`, [v], /Only a draft version can be deleted/);
      await q(`insert into inventory_batches (organization_id, version_id, made_on, made_by) values (${ORG}, $1, current_date, $2)`, [v, user]);
    });
  });

  test("an agent may propose a purchase, but only a person of the business approves it, in order, with an audit trail", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      const agent = (await one(
        `insert into users (email, full_name, is_service) values ($1, 'Inventory agent', true) returning id`,
        [`agent-${tag()}@service.invalid`],
      )).id;
      await q(`insert into memberships (user_id, organization_id, role) values ($1, $2, 'member')`, [agent, org]);
      await asApp(org, agent);
      const p = await product("Approved powder", await material("Approved powder"), 100);
      const seller = await vendor("Approval vendor");
      const offer = (await one(
        `insert into inventory_offers (organization_id, vendor_id, product_id, package_quantity, package_unit, price, stock_status)
         values (${ORG}, $1, $2, 100, 'g', 5, 'in_stock') returning id`,
        [seller.businessId, p],
      )).id;
      const intent = (await one(
        `insert into inventory_purchase_intents (organization_id, offer_id, packages, proposed_by, idempotency_key)
         values (${ORG}, $1, 1, $2, 'proposal-1') returning id`,
        [offer, agent],
      )).id;
      await fails(
        `update inventory_purchase_intents set status = 'approved', approved_by = $2, approved_at = now() where id = $1`,
        [intent, agent],
        /approved by the person approving it, who belongs to this business/,
      );
      await fails(
        `update inventory_purchase_intents set status = 'in_cart', carted_at = now() where id = $1`,
        [intent],
        /inventory_purchase_intents_approved|cannot go from proposed to in_cart/,
      );
      await asApp(org, user);
      await q(`update inventory_purchase_intents set status = 'approved', approved_by = $2, approved_at = now() where id = $1`, [intent, user]);
      await fails(`update inventory_purchase_intents set status = 'ordered' where id = $1`, [intent], /inventory_purchase_intents_carted|cannot go from approved to ordered/);
      await asApp(org, agent);
      await q(`update inventory_purchase_intents set status = 'in_cart', carted_at = now(), cart_reference = 'cart-1' where id = $1`, [intent]);
      const audit = await q(
        `select action, actor_user_id from audit_events where target = $1 order by id`,
        [`inventory_purchase_intents:${intent}`],
      );
      expect(audit).toEqual([
        { action: "inventory.purchase.proposed", actor_user_id: agent },
        { action: "inventory.purchase.approved", actor_user_id: user },
        { action: "inventory.purchase.in_cart", actor_user_id: agent },
      ]);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Review of 7714b8f                                                    */
/* ------------------------------------------------------------------ */

/*
 * Codex reviewed the first draft (commit 7714b8f) and reproduced each of these
 * against it in a disposable PostgreSQL 18.6. Every test in this section fails
 * on that commit; they are what the revision is held to.
 */

/** A lot of the product with a best-before date `days` from today. */
async function lotExpiringIn(productId: string, days: number) {
  return (await one(
    `insert into inventory_lots (organization_id, product_id, expiry_kind, expiry_date)
     values (${ORG}, $1, 'best_before', current_date + $2::int) returning id`,
    [productId, days],
  )).id as string;
}

/** A sealed package in that lot, catalogued at its label weight. */
async function sealedIn(lotId: string, grams: number) {
  const c = await container(lotId, "sealed", grams);
  await move(c, "opening", grams, "labelled_unopened");
  return c;
}

/** A sealed package of its own single-material product. */
async function sealedStock(materialId: string, grams: number) {
  return sealedIn(await lot(await product(`Stocked ${tag()}`, materialId, grams)), grams);
}

/** An active formulation: 1 g of the material per serving. */
async function oneGramRecipe(materialId: string) {
  const f = (await one(
    `insert into inventory_formulations (organization_id, name) values (${ORG}, $1) returning id`,
    [`Recipe ${tag()}`],
  )).id;
  const v = (await one(
    `insert into inventory_formulation_versions (organization_id, formulation_id, label) values (${ORG}, $1, 'v1') returning id`,
    [f],
  )).id as string;
  await q(
    `insert into inventory_formulation_lines (organization_id, version_id, material_id, quantity, unit) values (${ORG}, $1, $2, 1, 'g')`,
    [v, materialId],
  );
  await q(`update inventory_formulation_versions set status = 'active' where id = $1`, [v]);
  return v;
}

/** A plan for `grams` servings of that recipe, `days` from today. */
async function planIn(versionId: string, days: number, grams: number) {
  return (await one(
    `insert into inventory_batch_plans (organization_id, version_id, planned_for, servings)
     values (${ORG}, $1, current_date + $2::int, $3) returning id`,
    [versionId, days, grams],
  )).id as string;
}

/** An order placed with a vendor, expected `days` from today, for grams of a product. */
async function onOrder(productId: string, grams: number, days: number | null) {
  const seller = await vendor(`Vendor ${tag()}`);
  const order = (await one(
    `insert into inventory_orders (organization_id, vendor_id, order_number, expected_on, status)
     values (${ORG}, $1, $2, current_date + $3::int, 'placed') returning id`,
    [seller.businessId, `R-${tag()}`, days],
  )).id as string;
  await q(
    `insert into inventory_order_lines (organization_id, order_id, description, product_id, packages, package_quantity, package_unit)
     values (${ORG}, $1, 'on order', $2, 1, $3, 'g')`,
    [order, productId, grams],
  );
  return order;
}

async function requirementOf(planId: string, materialId: string) {
  const r = await one(
    `select required, shortfall, allocated_from_stock, allocated_from_incoming
       from inventory_plan_requirements where plan_id = $1 and material_id = $2`,
    [planId, materialId],
  );
  return {
    required: num(r.required),
    shortfall: num(r.shortfall),
    fromStock: num(r.allocated_from_stock),
    fromIncoming: num(r.allocated_from_incoming),
  };
}

async function shortfallOf(planId: string, materialId: string) {
  return num((await one(
    `select shortfall from inventory_plan_requirements where plan_id = $1 and material_id = $2`,
    [planId, materialId],
  )).shortfall);
}

async function reservationState(planId: string) {
  const r = await one(
    `select reserved_for_plan, reserved_valid, reserved_unbacked, reservations_to_review
       from inventory_plan_requirements where plan_id = $1`,
    [planId],
  );
  return {
    reserved: num(r.reserved_for_plan),
    valid: num(r.reserved_valid),
    unbacked: num(r.reserved_unbacked),
    review: num(r.reservations_to_review),
  };
}

const RESERVE = `insert into inventory_reservations (organization_id, plan_id, container_id, material_id, quantity, unit)
                 values (${ORG}, $1, $2, $3, $4, $5) returning id`;

async function reserve(planId: string, containerId: string, materialId: string, quantity: number, unit = "g") {
  return (await one(RESERVE, [planId, containerId, materialId, quantity, unit])).id as string;
}

describe("review of 7714b8f: reservations", () => {
  test("R1 a reservation counts only while its jar can give that plan the stock: a hold or an expiry after reserving undoes it", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const fx = await planningFixture(user);
      await reserve(fx.plan200, fx.stock, fx.m, 200);
      expect(await totalShortfall(fx.m)).toBe(80);

      // The reserved jar goes on hold: it gives nothing, to any plan.
      const stockLot = (await one(`select lot_id from inventory_containers where id = $1`, [fx.stock])).lot_id;
      await q(`update inventory_lots set hold = 'quarantine', hold_reason = 'damp' where id = $1`, [stockLot]);
      expect(await totalShortfall(fx.m)).toBe(300); // 350 g needed, only the 50 g delivery usable
      expect(await shortfallOf(fx.plan200, fx.m)).toBeGreaterThan(0);
      expect(await reservationState(fx.plan200)).toEqual({ reserved: 200, valid: 0, unbacked: 200, review: 1 });

      // Off hold, but best before day 10 and the plans are on day 14: still nothing.
      await q(
        `update inventory_lots set hold = 'none', hold_reason = null, expiry_kind = 'best_before', expiry_date = current_date + 10
          where id = $1`,
        [stockLot],
      );
      expect(await totalShortfall(fx.m)).toBe(300);
      expect(await reservationState(fx.plan200)).toEqual({ reserved: 200, valid: 0, unbacked: 200, review: 1 });

      // The plan moves to day 9, before the date: the reservation holds again.
      await q(`update inventory_batch_plans set planned_for = current_date + 9 where id = $1`, [fx.plan200]);
      expect(await reservationState(fx.plan200)).toEqual({ reserved: 200, valid: 200, unbacked: 0, review: 0 });
      expect(await shortfallOf(fx.plan200, fx.m)).toBe(0);
      // The other 20 g expire before day 14, so the 50 g delivery is all the later plan has.
      expect(await shortfallOf(fx.plan150, fx.m)).toBe(100);
    });
  });

  test("R1 a reservation that cannot be honoured is refused: more than the jar holds across plans, unknown amount, on hold, expired by the plan, another material, ml of a weighed material, a closed plan", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const fx = await planningFixture(user);

      // 220 g in the jar: 200 g for one plan, then 100 g more for the other is too much.
      await reserve(fx.plan200, fx.stock, fx.m, 200);
      await fails(RESERVE, [fx.plan150, fx.stock, fx.m, 100, "g"], /already reserved/);
      await reserve(fx.plan150, fx.stock, fx.m, 20); // exactly what is left

      const unknownJar = await container(await lot(fx.p), "open", 1000);
      await move(unknownJar, "opening", null, "unknown");
      await fails(RESERVE, [fx.plan150, unknownJar, fx.m, 10, "g"], /unknown/);

      const heldJar = await sealedIn(await lot(fx.p, { hold: "review" }), 100);
      await fails(RESERVE, [fx.plan150, heldJar, fx.m, 10, "g"], /on hold/);

      const oldJar = await sealedIn(await lotExpiringIn(fx.p, 5), 100);
      await fails(RESERVE, [fx.plan150, oldJar, fx.m, 10, "g"], /expires before/);

      const other = await material("Unplanned powder");
      const otherJar = await sealedStock(other, 100);
      await fails(RESERVE, [fx.plan150, otherJar, fx.m, 10, "g"], /not recorded as holding/);
      await fails(RESERVE, [fx.plan150, otherJar, other, 10, "g"], /does not use/);

      const freshJar = await sealedIn(await lot(fx.p), 100);
      await fails(RESERVE, [fx.plan150, freshJar, fx.m, 10, "ml"], /counted by mass/);

      await q(`update inventory_batch_plans set status = 'cancelled' where id = $1`, [fx.plan150]);
      await fails(RESERVE, [fx.plan150, freshJar, fx.m, 10, "g"], /open plan/);
    });
  });

  test("R1 reservations are checked again on every read: a loss after reserving, or an amount that becomes unknown, shows as short and to review", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const fx = await planningFixture(user);
      await reserve(fx.plan200, fx.stock, fx.m, 200);
      await reserve(fx.plan150, fx.stock, fx.m, 20);
      expect(await totalShortfall(fx.m)).toBe(80);

      // 50 g lost after reserving: 170 g left against 220 g of reservations. The first reservation is served first.
      await move(fx.stock, "loss", -50, "estimated", { note: "spilt" });
      expect(await totalShortfall(fx.m)).toBe(130); // 350 g needed, 170 g in the jar, 50 g arriving
      expect(await reservationState(fx.plan200)).toEqual({ reserved: 200, valid: 170, unbacked: 30, review: 1 });
      expect(await reservationState(fx.plan150)).toEqual({ reserved: 20, valid: 0, unbacked: 20, review: 1 });

      // A jar whose estimate is withdrawn after reserving from it is unknown again, and gives nothing.
      const jar = await container(await lot(fx.p), "open", 1000);
      await move(jar, "opening", null, "unknown");
      const estimate = await move(jar, "count", 300, "estimated");
      await reserve(fx.plan150, jar, fx.m, 100);
      expect((await reservationState(fx.plan150)).valid).toBe(100);
      await move(jar, "reversal", null, null, { reverses_id: estimate, note: "that estimate was for another jar" });
      expect(await reservationState(fx.plan150)).toEqual({ reserved: 120, valid: 0, unbacked: 120, review: 2 });
    });
  });
});

describe("review of 7714b8f: planning across expiry dates and deliveries", () => {
  test("R2 stock expiring between two plans is used by the earlier one: 200 g on day 7 and 150 g on day 14, from 200 g best before day 10 and 150 g best before day 20, is nothing short", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const m = await material("Expiring powder");
      const p = await product("Expiring powder bulk", m, 1000);
      await sealedIn(await lotExpiringIn(p, 10), 200);
      await sealedIn(await lotExpiringIn(p, 20), 150);
      const v = await oneGramRecipe(m);
      const early = await planIn(v, 7, 200);
      const late = await planIn(v, 14, 150);
      expect(await totalShortfall(m)).toBe(0);
      expect(await requirementOf(early, m)).toEqual({ required: 200, shortfall: 0, fromStock: 200, fromIncoming: 0 });
      expect(await requirementOf(late, m)).toEqual({ required: 150, shortfall: 0, fromStock: 150, fromIncoming: 0 });
    });
  });

  test("R2 staggered deliveries: a delivery covers the plans on or after its expected day, after the expiring stock is used", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const m = await material("Staggered powder");
      const p = await product("Staggered powder bulk", m, 1000);
      await sealedIn(await lotExpiringIn(p, 10), 200); // 200 g, best before day 10
      await onOrder(p, 200, 12); // 200 g expected day 12
      const v = await oneGramRecipe(m);
      const first = await planIn(v, 7, 200);
      const second = await planIn(v, 14, 200);
      expect(await totalShortfall(m)).toBe(0);
      expect(await requirementOf(first, m)).toEqual({ required: 200, shortfall: 0, fromStock: 200, fromIncoming: 0 });
      expect(await requirementOf(second, m)).toEqual({ required: 200, shortfall: 0, fromStock: 0, fromIncoming: 200 });
    });
  });

  test("R2 a delivery after a plan's date helps only later plans, and is counted once", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const m = await material("Late powder");
      const p = await product("Late powder bulk", m, 1000);
      await sealedIn(await lot(p), 100); // 100 g, no date
      await onOrder(p, 200, 10); // 200 g expected day 10
      const v = await oneGramRecipe(m);
      const a = await planIn(v, 7, 300);
      const b = await planIn(v, 14, 200);
      expect(await totalShortfall(m)).toBe(200);
      expect(await requirementOf(a, m)).toEqual({ required: 300, shortfall: 200, fromStock: 100, fromIncoming: 0 });
      expect(await requirementOf(b, m)).toEqual({ required: 200, shortfall: 0, fromStock: 0, fromIncoming: 200 });
    });
  });

  test("R2 a requirement that cannot be counted is refused or shown as unknown, never quietly smaller", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const m = await material("Dosed powder");
      const f = (await one(`insert into inventory_formulations (organization_id, name) values (${ORG}, 'Dosed blend') returning id`)).id;
      const v = (await one(
        `insert into inventory_formulation_versions (organization_id, formulation_id, label) values (${ORG}, $1, 'v1') returning id`,
        [f],
      )).id;
      const LINE = `insert into inventory_formulation_lines (organization_id, version_id, material_id, quantity, unit, role)
                    values (${ORG}, $1, $2, 5, $3, $4)`;
      await fails(LINE, [v, m, "iu", "batch"], /cannot be counted against this material/);
      await fails(LINE, [v, m, "ml", "required_addition"], /cannot be counted against this material/);
      await q(LINE, [v, m, "g", "batch"]);
      await q(`update inventory_formulation_versions set status = 'active' where id = $1`, [v]);
      const plan = await planIn(v, 14, 20); // 20 servings of 5 g
      await sealedStock(m, 50);
      expect(await requirementOf(plan, m)).toMatchObject({ required: 100, shortfall: 50 });

      // Re-described as measured by volume, the grams in the recipe no longer count against it: unknown, not zero.
      await q(`update inventory_materials set dimension = 'volume' where id = $1`, [m]);
      expect(await requirementOf(plan, m)).toMatchObject({ required: null, shortfall: null });
    });
  });
});

describe("review of 7714b8f: purchase approval", () => {
  /** A proposal for 1 package at 5.00 CAD, made by the business's agent (a service account). */
  async function proposal() {
    const { org, user } = await business();
    const agent = (await one(
      `insert into users (email, full_name, is_service) values ($1, 'Inventory agent', true) returning id`,
      [`agent-${tag()}@service.invalid`],
    )).id as string;
    await q(`insert into memberships (user_id, organization_id, role) values ($1, $2, 'member')`, [agent, org]);
    await asApp(org, agent);
    const p = await product("Proposed powder", await material("Proposed powder"), 100);
    const seller = await vendor("Proposal vendor");
    const offer = (await one(
      `insert into inventory_offers (organization_id, vendor_id, product_id, package_quantity, package_unit, price, stock_status)
       values (${ORG}, $1, $2, 100, 'g', 5, 'in_stock') returning id`,
      [seller.businessId, p],
    )).id as string;
    const otherOffer = (await one(
      `insert into inventory_offers (organization_id, vendor_id, product_id, package_quantity, package_unit, price, stock_status)
       values (${ORG}, $1, $2, 1000, 'g', 40, 'in_stock') returning id`,
      [seller.businessId, p],
    )).id as string;
    const intent = (await one(
      `insert into inventory_purchase_intents (organization_id, offer_id, packages, expected_total, proposed_by, idempotency_key)
       values (${ORG}, $1, 1, 5, $2, $3) returning id`,
      [offer, agent, `proposal-${tag()}`],
    )).id as string;
    return { org, user, agent, offer, otherOffer, intent };
  }

  test("R3 the agent cannot approve in a person's name: an approval is by whoever is acting, a person of the business, at the database's time", async () => {
    await inRollback(async () => {
      const fx = await proposal(); // acting as the agent
      await fails(
        `update inventory_purchase_intents set status = 'approved', approved_by = $2, approved_at = now() where id = $1`,
        [fx.intent, fx.user],
        /approved by the person approving it/,
      );
      await fails(`update inventory_purchase_intents set approved_by = $2 where id = $1`, [fx.intent, fx.user], /recorded once, by the approval/);
      await fails(
        `insert into inventory_purchase_intents (organization_id, offer_id, packages, status, approved_by, approved_at)
         values (${ORG}, $1, 1, 'approved', $2, now())`,
        [fx.offer, fx.user],
        /approved by the person approving it/,
      );

      await asApp(fx.org, fx.user);
      await q(
        `update inventory_purchase_intents set status = 'approved', approved_by = $2, approved_at = '2000-01-01' where id = $1`,
        [fx.intent, fx.user],
      );
      const row = await one(
        `select approved_by, approved_at > now() - interval '1 minute' as recent from inventory_purchase_intents where id = $1`,
        [fx.intent],
      );
      expect(row).toEqual({ approved_by: fx.user, recent: true });
    });
  });

  test("R3 the terms are frozen once approved, and an approval cannot change them; a revision before approval is audited", async () => {
    await inRollback(async () => {
      const fx = await proposal();
      await q(`update inventory_purchase_intents set packages = 2, expected_total = 10 where id = $1`, [fx.intent]);

      await asApp(fx.org, fx.user);
      await fails(
        `update inventory_purchase_intents set status = 'approved', approved_by = $2, packages = 3 where id = $1`,
        [fx.intent, fx.user],
        /on the terms as proposed/,
      );
      await q(`update inventory_purchase_intents set status = 'approved', approved_by = $2 where id = $1`, [fx.intent, fx.user]);

      await asApp(fx.org, fx.agent);
      const FROZEN = /keeps the terms it was approved on/;
      await fails(`update inventory_purchase_intents set packages = 100 where id = $1`, [fx.intent], FROZEN);
      await fails(`update inventory_purchase_intents set expected_total = 500 where id = $1`, [fx.intent], FROZEN);
      await fails(`update inventory_purchase_intents set currency = 'USD' where id = $1`, [fx.intent], FROZEN);
      await fails(`update inventory_purchase_intents set offer_id = $2 where id = $1`, [fx.intent, fx.otherOffer], FROZEN);
      await asApp(fx.org, fx.user);
      await fails(`update inventory_purchase_intents set packages = 100 where id = $1`, [fx.intent], FROZEN);
      await fails(`update inventory_purchase_intents set approved_by = $2 where id = $1`, [fx.intent, fx.agent], /recorded once, by the approval/);

      await asApp(fx.org, fx.agent);
      await q(`update inventory_purchase_intents set status = 'in_cart', carted_at = now(), cart_reference = 'cart-1' where id = $1`, [fx.intent]);
      await fails(`update inventory_purchase_intents set packages = 100 where id = $1`, [fx.intent], FROZEN);

      const row = await one(`select packages, expected_total, currency, offer_id from inventory_purchase_intents where id = $1`, [fx.intent]);
      expect([num(row.packages), num(row.expected_total), row.currency, row.offer_id]).toEqual([2, 10, "CAD", fx.offer]);
      const audit = await q(`select action, actor_user_id from audit_events where target = $1 order by id`, [`inventory_purchase_intents:${fx.intent}`]);
      expect(audit).toEqual([
        { action: "inventory.purchase.proposed", actor_user_id: fx.agent },
        { action: "inventory.purchase.revised", actor_user_id: fx.agent },
        { action: "inventory.purchase.approved", actor_user_id: fx.user },
        { action: "inventory.purchase.in_cart", actor_user_id: fx.agent },
      ]);
    });
  });
});

describe("review of 7714b8f: weighing evidence", () => {
  const WEIGH = `insert into inventory_measurements (organization_id, container_id, gross_g, tare_g, tare_basis, net_g, method, confidence)
                 values (${ORG}, $1, $2, $3, $4, $5, $6, $7) returning id`;
  const MEASURED = `insert into inventory_movements (organization_id, container_id, kind, quantity, unit, basis, measurement_id)
                    values (${ORG}, $1, $2, $3, $4, 'measured', $5)`;

  test("R4 a visual or rough figure, a label or an estimated tare is never a measured amount", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const c = await container(await lot(await product("Eyeballed powder", await material("Eyeballed powder"))), "open");
      await move(c, "opening", null, "unknown");

      const eyeballed = (await one(WEIGH, [c, null, null, null, 90, "visual_estimate", "rough"])).id;
      await fails(MEASURED, [c, "count", 90, "g", eyeballed], /exact scale weighing/);
      await move(c, "count", 90, "estimated", { measurement_id: eyeballed });
      expect(await balanceOf(c)).toEqual({ balance: 90, basis: "estimated" });

      const guessedTare = (await one(WEIGH, [c, 330, 30, "estimated", 300, "scale", "exact"])).id;
      await fails(MEASURED, [c, "count", 300, "g", guessedTare], /exact scale weighing/);
      const fromLabel = (await one(WEIGH, [c, null, null, null, 300, "label", "exact"])).id;
      await fails(MEASURED, [c, "count", 300, "g", fromLabel], /exact scale weighing/);
      const roughScale = (await one(WEIGH, [c, null, null, null, 300, "scale", "rough"])).id;
      await fails(MEASURED, [c, "count", 300, "g", roughScale], /exact scale weighing/);
      expect(await balanceOf(c)).toEqual({ balance: 90, basis: "estimated" });

      const weighed = (await one(WEIGH, [c, 330, 30, "measured", 300, "scale", "exact"])).id;
      await q(MEASURED, [c, "count", 0.3, "kg", weighed]);
      expect(await balanceOf(c)).toEqual({ balance: 300, basis: "measured" });
    });
  });

  test("R4 a weighing never measures millilitres or items", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const l = await lot(await product("Measured syrup", await material("Measured syrup")));
      const bottle = (await one(
        `insert into inventory_containers (organization_id, lot_id, status, dimension) values (${ORG}, $1, 'open', 'volume') returning id`,
        [l],
      )).id;
      const bottleWeighing = (await one(WEIGH, [bottle, null, null, null, 100, "scale", "exact"])).id;
      await fails(MEASURED, [bottle, "opening", 100, "ml", bottleWeighing], /weighing measures grams/);
      const tub = (await one(
        `insert into inventory_containers (organization_id, lot_id, status, dimension) values (${ORG}, $1, 'open', 'count') returning id`,
        [l],
      )).id;
      const tubWeighing = (await one(WEIGH, [tub, null, null, null, 100, "scale", "exact"])).id;
      await fails(MEASURED, [tub, "opening", 100, "count", tubWeighing], /weighing measures grams/);
      expect(await balanceOf(bottle)).toEqual({ balance: null, basis: "unknown" });
    });
  });

  test("R4 a weighing a stock event rests on cannot be edited or removed, by the portal or the owner; a correction is a new weighing and count", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const c = await container(await lot(await product("Evidence powder", await material("Evidence powder"))), "open");
      await move(c, "opening", null, "unknown");
      const weighed = (await one(WEIGH, [c, 330, 30, "measured", 300, "scale", "exact"])).id;
      await q(MEASURED, [c, "count", 300, "g", weighed]);

      await fails(`update inventory_measurements set net_g = 40, gross_g = 70 where id = $1`, [weighed], /permission denied/);
      await fails(`delete from inventory_measurements where id = $1`, [weighed], /permission denied/);
      const spare = (await one(WEIGH, [c, null, null, null, 10, "visual_estimate", "rough"])).id;
      await fails(`update inventory_measurements set net_g = 20 where id = $1`, [spare], /permission denied/);

      await asOwner();
      await fails(`update inventory_measurements set net_g = 40, gross_g = 70 where id = $1`, [weighed], /evidence for a stock event/);
      await fails(`delete from inventory_measurements where id = $1`, [weighed], /evidence for a stock event/);

      await asApp(org, user);
      expect(await balanceOf(c)).toEqual({ balance: 300, basis: "measured" });
      const reweighed = (await one(WEIGH, [c, 320, 30, "measured", 290, "scale", "exact"])).id;
      await q(MEASURED, [c, "count", 290, "g", reweighed]);
      expect(await balanceOf(c)).toEqual({ balance: 290, basis: "measured" });
    });
  });

  test("R4 a label amount is the package's nominal contents, in any unit of the same kind", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const l = await lot(await product("Labelled powder", await material("Labelled powder"), 500));
      const LABELLED = `insert into inventory_movements (organization_id, container_id, kind, quantity, unit, basis)
                        values (${ORG}, $1, 'opening', $2, $3, 'labelled_unopened')`;
      const jar = await container(l, "sealed", 500);
      await fails(LABELLED, [jar, 450, "g"], /nominal contents/);
      const unlabelled = await container(l, "sealed");
      await fails(LABELLED, [unlabelled, 500, "g"], /nominal contents/);
      await q(LABELLED, [jar, 0.5, "kg"]);
      expect(await balanceOf(jar)).toEqual({ balance: 500, basis: "labelled_unopened" });
    });
  });
});

describe("review of 7714b8f: one photo, several jars", () => {
  test("R5 one label photo is evidence for two captures and two jars; each link is made once; one capture creates a container", async () => {
    await inRollback(async () => {
      const { org, user } = await business();
      await asApp(org, user);
      const l = await lot(await product("Twin jars", await material("Twin jars"), 250));
      const capture = async () =>
        (await one(`insert into inventory_captures (organization_id, created_by) values (${ORG}, $1) returning id`, [user])).id as string;
      const [first, second] = [await capture(), await capture()];
      const photo = (await one(
        `insert into inventory_documents (organization_id, capture_id, kind, content_type, storage_key, byte_size, sha256, uploaded_by, state)
         values (${ORG}, $1, 'photo', 'image/jpeg', $2, 1000, decode($3, 'hex'), $4, 'stored') returning id`,
        [first, `inventory/${org}/${randomBytes(18).toString("base64url")}.jpg`, randomBytes(32).toString("hex"), user],
      )).id;
      const LINK = `insert into inventory_document_links (organization_id, document_id, capture_id, container_id)
                    values (${ORG}, $1, $2, $3)`;
      await q(LINK, [photo, first, null]);
      await q(LINK, [photo, second, null]);
      await fails(LINK, [photo, first, null], /inventory_document_links_once/);
      expect(await q(`${LINK} on conflict do nothing returning 1`, [photo, first, null])).toHaveLength(0);

      const confirm = async (captureId: string, containerId: string, outcome: string) =>
        q(
          `update inventory_captures set status = 'confirmed', container_id = $2, outcome = $3, confirmed_by = $4, confirmed_at = now()
            where id = $1`,
          [captureId, containerId, outcome, user],
        );
      const [jar1, jar2] = [await container(l, "sealed", 250), await container(l, "sealed", 250)];
      await confirm(first, jar1, "new_container");
      await confirm(second, jar2, "new_container");
      await q(LINK, [photo, null, jar1]);
      await q(LINK, [photo, null, jar2]);

      // A third capture of the first jar can confirm it as existing, never as newly created.
      const third = await capture();
      await fails(
        `update inventory_captures set status = 'confirmed', container_id = $2, outcome = 'new_container', confirmed_by = $3, confirmed_at = now() where id = $1`,
        [third, jar1, user],
        /inventory_captures_one_creator/,
      );
      await confirm(third, jar1, "existing_container");

      const links = await one(
        `select count(capture_id)::int as captures, count(container_id)::int as containers from inventory_document_links where document_id = $1`,
        [photo],
      );
      expect(links).toEqual({ captures: 2, containers: 2 });
    });
  });
});
