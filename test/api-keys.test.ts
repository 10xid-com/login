import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { getJob, listJobs, type Scope } from "@/lib/db";
import {
  identifyKey,
  listKeys,
  mintKey,
  revokeKey,
  touchKey,
} from "@/lib/db/api-keys";
import { closePool } from "@/lib/db/connection";
import { mayCreateSignIn } from "@/lib/db/accounts";

/**
 * Keys for machines, held to the same rule as people.
 *
 * The claim being tested is narrow and worth stating exactly: a key belonging
 * to one client can file work into that client and cannot read, write or reach
 * any other client — including by asking for a row by its exact id, which is the
 * attack that a filter written in TypeScript would pass and a database policy
 * would not.
 *
 * It is also tested that the identity a key acts as cannot be used to sign in.
 * That is the failure this design would otherwise introduce: a key is
 * deliberately write-only, so an account behind it that could hold a session
 * would hand over exactly the read access the key was built not to have.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const appRole = new Client({ connectionString: process.env.DATABASE_APP_URL });

let rotaryId = "";
let northstarId = "";
let northstarJobId = "";
let paoloId = "";

beforeAll(async () => {
  await owner.connect();
  await appRole.connect();

  const { rows } = await owner.query(`
    select
      (select id from organizations where slug = 'rotary')    as rotary,
      (select id from organizations where slug = 'northstar') as northstar,
      (select id from users where email = 'paolo@brandingcentres.test') as paolo,
      (select id from jobs where ref = 'NOR-0001')            as northstar_job
  `);
  rotaryId = rows[0].rotary;
  northstarId = rows[0].northstar;
  paoloId = rows[0].paolo;
  northstarJobId = rows[0].northstar_job;

  expect(rotaryId, "seed data missing — run npm run db:seed").toBeTruthy();
  expect(northstarId).toBeTruthy();
});

afterAll(async () => {
  await owner.end();
  await appRole.end();
  await closePool();
});

/** The scope the intake endpoint builds, from the key row and nothing else. */
function scopeForKey(key: {
  serviceUserId: string;
  serviceEmail: string;
  organizationId: string;
}): Scope {
  return {
    userId: key.serviceUserId,
    email: key.serviceEmail,
    isStaff: false,
    organizationId: key.organizationId,
  };
}

describe("a key is a credential in its own right", () => {
  test("the value is shown once and only its hash is kept", async () => {
    const minted = await mintKey({
      organizationId: northstarId,
      label: "Northstar website — hash test",
      createdBy: paoloId,
    });

    const { rows } = await owner.query(
      "select key_hash, prefix from api_keys where id = $1",
      [minted.id],
    );

    // Nothing resembling the key itself is stored — only a digest of it.
    const stored = rows[0].key_hash.toString("hex");
    expect(stored).toHaveLength(64);
    expect(stored).not.toContain(minted.secret);
    expect(minted.secret).not.toContain(stored);

    // The visible prefix is a label, not a credential: it is far too short to
    // be guessed back into the key.
    expect(minted.secret.startsWith(rows[0].prefix)).toBe(true);
    expect(rows[0].prefix.length).toBeLessThan(minted.secret.length / 2);
  });

  test("a well-formed key that was never minted is refused", async () => {
    expect(await identifyKey("10xid_live_" + "A".repeat(43))).toBeNull();
  });

  test("something that is not a key at all is refused", async () => {
    expect(await identifyKey("")).toBeNull();
    expect(await identifyKey("Bearer")).toBeNull();
    expect(await identifyKey("hunter2")).toBeNull();
  });
});

describe("a key reaches one client and no other", () => {
  test("it files into its own company", async () => {
    const minted = await mintKey({
      organizationId: northstarId,
      label: "Northstar website — filing test",
      createdBy: paoloId,
    });

    const identified = await identifyKey(minted.secret);
    expect(identified).not.toBeNull();
    expect(identified!.organizationId).toBe(northstarId);

    const { createJob } = await import("@/lib/db");
    const job = await createJob(scopeForKey(identified!), {
      title: "Estimate request from the website",
      direction: "from_client",
      details: { name: "A Person", roof: "Asphalt shingle" },
    });

    expect(job.organizationId).toBe(northstarId);
    expect(job.ref.startsWith("NOR-")).toBe(true);
  });

  test("it cannot file into a different company", async () => {
    const minted = await mintKey({
      organizationId: northstarId,
      label: "Northstar website — cross-tenant write test",
      createdBy: paoloId,
    });
    const identified = (await identifyKey(minted.secret))!;

    // The endpoint reads the company off the key, so there is no field to
    // tamper with. This goes underneath that and forces the wrong company in
    // directly — the thing a bug in the endpoint would do — and the database
    // refuses it.
    await appRole.query("begin");
    await appRole.query("select set_config('app.org_id', $1, true)", [
      northstarId,
    ]);

    await expect(
      appRole.query(
        `insert into jobs (id, organization_id, ref, direction, title, created_by)
         values (gen_random_uuid(), $1, 'HACK-KEY', 'from_client', 'smuggled', $2)`,
        [rotaryId, identified.serviceUserId],
      ),
    ).rejects.toThrow(/row-level security/i);

    await appRole.query("rollback");
  });

  test("it cannot read another company's jobs, even by exact id", async () => {
    const minted = await mintKey({
      organizationId: rotaryId,
      label: "Rotary — read attempt test",
      createdBy: paoloId,
    });
    const identified = (await identifyKey(minted.secret))!;
    const scope = scopeForKey(identified);

    const visible = await listJobs(scope);
    expect(visible.every((j) => j.organizationId === rotaryId)).toBe(true);
    expect(await getJob(scope, northstarJobId)).toBeNull();
  });

  test("the key list is scoped like everything else", async () => {
    await mintKey({
      organizationId: northstarId,
      label: "Northstar — listing test",
      createdBy: paoloId,
    });

    const asRotary = await listKeys({ isStaff: false, organizationId: rotaryId });
    expect(asRotary.length).toBeGreaterThan(0);
    expect(asRotary.every((k) => k.organizationId === rotaryId)).toBe(true);

    // Staff surveying see every company's keys; a client sees only their own.
    const asStaff = await listKeys({ isStaff: true, organizationId: null });
    expect(new Set(asStaff.map((k) => k.organizationId)).size).toBeGreaterThan(1);
  });
});

describe("revoking", () => {
  test("a revoked key stops working immediately", async () => {
    const minted = await mintKey({
      organizationId: northstarId,
      label: "Northstar — revocation test",
      createdBy: paoloId,
    });

    expect(await identifyKey(minted.secret)).not.toBeNull();

    await revokeKey(northstarId, minted.id);

    // Same answer as a key that never existed. A caller learns that it did not
    // work, not that it used to.
    expect(await identifyKey(minted.secret)).toBeNull();
  });

  test("revoking leaves the work the key filed in place", async () => {
    const minted = await mintKey({
      organizationId: northstarId,
      label: "Northstar — audit survival test",
      createdBy: paoloId,
    });
    const identified = (await identifyKey(minted.secret))!;

    const { createJob } = await import("@/lib/db");
    const job = await createJob(scopeForKey(identified), {
      title: "Filed before revocation",
      direction: "from_client",
    });

    await revokeKey(northstarId, minted.id);

    const staffScope: Scope = {
      userId: paoloId,
      email: "paolo@brandingcentres.test",
      isStaff: true,
      organizationId: northstarId,
    };
    const still = await getJob(staffScope, job.id);
    expect(still).not.toBeNull();
    expect(still!.title).toBe("Filed before revocation");
  });

  test("one company cannot revoke another company's key", async () => {
    const minted = await mintKey({
      organizationId: northstarId,
      label: "Northstar — cross-tenant revocation test",
      createdBy: paoloId,
    });

    // Rotary's scope, Northstar's key id. The update matches no visible row, so
    // it changes nothing and raises nothing — and the key keeps working.
    await revokeKey(rotaryId, minted.id);

    expect(await identifyKey(minted.secret)).not.toBeNull();
  });
});

describe("the service account behind a key", () => {
  test("cannot be signed in as: no sign-in identity may exist for it", async () => {
    const minted = await mintKey({
      organizationId: northstarId,
      label: "Northstar — sign-in refusal test",
      createdBy: paoloId,
    });
    const identified = (await identifyKey(minted.secret))!;

    // The login host creates a sign-in identity only for an invited address or
    // a human account; a service account's address is neither, so no password,
    // emailed code or provider can ever be attached to it.
    expect(await mayCreateSignIn(identified.serviceEmail)).toBe(false);
  });

  test("its address is on a domain that can never receive mail", async () => {
    const minted = await mintKey({
      organizationId: northstarId,
      label: "Northstar — address test",
      createdBy: paoloId,
    });
    const identified = (await identifyKey(minted.secret))!;

    // RFC 2606 reserves .invalid precisely so that it can never be delegated,
    // so there is no mailbox for a code to be delivered to in the first place.
    expect(identified.serviceEmail.endsWith(".invalid")).toBe(true);
  });

  test("is marked as a service account, not as a person", async () => {
    const minted = await mintKey({
      organizationId: northstarId,
      label: "Northstar — flag test",
      createdBy: paoloId,
    });
    const identified = (await identifyKey(minted.secret))!;

    const { rows } = await owner.query(
      "select is_service, is_staff from users where id = $1",
      [identified.serviceUserId],
    );
    expect(rows[0].is_service).toBe(true);
    expect(rows[0].is_staff).toBe(false);
  });
});

describe("the authentication exception is narrow", () => {
  test("the lookup flag admits reads and refuses writes", async () => {
    // The api_keys table keeps its tenant policy and adds ONE extra policy, so
    // that a key can be found before anyone knows which company it belongs to.
    // That policy is SELECT-only, which is what stops it being a way to mint a
    // key or move one between companies. Asserted here rather than assumed.
    //
    // The two refusals look different and both matter. An INSERT is rejected
    // outright, because the tenant policy's WITH CHECK demands a company that
    // is not set. An UPDATE is not rejected — it simply matches no rows, since
    // the SELECT-only policy does not make rows visible to UPDATE. A silent
    // zero-row update IS the refusal, so it is asserted as one rather than
    // waiting for an error that will never come.
    try {
      await appRole.query("begin");
      await appRole.query("select set_config('app.authenticating', 'on', true)");

      const read = await appRole.query(
        "select count(*)::int as n from api_keys",
      );
      expect(read.rows[0].n).toBeGreaterThan(0);

      await expect(
        appRole.query(
          `insert into api_keys
             (organization_id, service_user_id, label, key_hash, prefix, created_by)
           values ($1, $2, 'minted through the exception', '\\x00'::bytea, 'x', $2)`,
          [northstarId, paoloId],
        ),
      ).rejects.toThrow(/row-level security/i);
      await appRole.query("rollback");

      await appRole.query("begin");
      await appRole.query("select set_config('app.authenticating', 'on', true)");
      const wrote = await appRole.query(
        "update api_keys set revoked_at = null, organization_id = $1",
        [rotaryId],
      );
      expect(wrote.rowCount).toBe(0);
    } finally {
      // Always, so that a failed assertion cannot leave this shared connection
      // inside an open transaction with the flag still set — which would make
      // every later test in this file read through an exception it never
      // asked for, and pass or fail for the wrong reason.
      await appRole.query("rollback");
    }
  });

  test("without the flag, an unscoped connection sees no keys", async () => {
    const { rows } = await appRole.query(
      "select count(*)::int as n from api_keys",
    );
    expect(rows[0].n).toBe(0);
  });

  test("recording use goes through the tenant policy, not the exception", async () => {
    const minted = await mintKey({
      organizationId: northstarId,
      label: "Northstar — last used test",
      createdBy: paoloId,
    });

    await touchKey(northstarId, minted.id);

    const { rows } = await owner.query(
      "select last_used_at from api_keys where id = $1",
      [minted.id],
    );
    expect(rows[0].last_used_at).not.toBeNull();
  });
});
