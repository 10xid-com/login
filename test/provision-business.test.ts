import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { provisionBusiness } from "../scripts/provision-business.mjs";

/**
 * scripts/provision-business.mjs: a private business for one existing person.
 * Every test runs in a transaction that is rolled back, as the owner — the
 * script is an operator's tool and connects as the owner too. The data is
 * synthetic.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
beforeAll(() => owner.connect());
afterAll(() => owner.end());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const q = async (text: string, params: unknown[] = []): Promise<Row[]> => (await owner.query(text, params)).rows;
const tag = () => randomBytes(4).toString("hex");

async function inRollback(fn: () => Promise<void>) {
  await owner.query("begin");
  try {
    await fn();
  } finally {
    await owner.query("rollback");
  }
}

async function refused(input: { name: string; slug: string; ownerEmail: string }, pattern: RegExp) {
  await owner.query("savepoint refused");
  let error: unknown = null;
  try {
    await provisionBusiness(owner, input);
  } catch (e) {
    error = e;
  }
  await owner.query("rollback to savepoint refused");
  expect(error, `expected a refusal for ${input.slug}`).not.toBeNull();
  expect(String((error as Error).message)).toMatch(pattern);
}

/** A person with one address, verified unless said otherwise. */
async function person(opts: { verified?: boolean; service?: boolean; deleted?: boolean } = {}) {
  const t = tag();
  const email = `provision-${t}@example.test`;
  const id = (await q(
    `insert into users (email, full_name, is_service, deleted_at) values ($1, $2, $3, $4) returning id`,
    [email, `Provision ${t}`, opts.service ?? false, opts.deleted ? new Date() : null],
  ))[0].id as string;
  // The account's address is mirrored into user_emails by the database; set
  // whether it is verified there, which is what provisioning trusts.
  await q(
    `insert into user_emails (user_id, email, is_primary) values ($1, $2, true) on conflict (email) do nothing`,
    [id, email],
  );
  await q(`update user_emails set verified_at = $2 where user_id = $1`, [id, opts.verified === false ? null : new Date()]);
  return { id, email };
}

const input = (ownerEmail: string, slug = `private-${tag()}`) => ({ name: "Private Nutrient Test", slug, ownerEmail });

describe("provisioning a private business", () => {
  test("creates the business and the owner's membership once; a second run finds both and changes nothing", async () => {
    await inRollback(async () => {
      const paolo = await person();
      const usersBefore = (await q(`select count(*)::int as n from users`))[0].n;
      const args = input(paolo.email.toUpperCase());

      const first = await provisionBusiness(owner, args);
      expect(first).toMatchObject({ createdBusiness: true, createdMembership: true, recordedOwner: false });
      const second = await provisionBusiness(owner, args);
      expect(second).toEqual({ ...first, createdBusiness: false, createdMembership: false });

      const org = (await q(`select type::text as type, name, owner_user_id, is_agency from organizations where id = $1`, [first.organizationId]))[0];
      expect(org).toEqual({ type: "client", name: "Private Nutrient Test", owner_user_id: paolo.id, is_agency: false });
      const members = await q(`select user_id, role::text as role from memberships where organization_id = $1`, [first.organizationId]);
      expect(members).toEqual([{ user_id: paolo.id, role: "owner" }]);
      expect((await q(`select count(*)::int as n from users`))[0].n).toBe(usersBefore);
    });
  });

  test("the owner must be an existing person with that address verified", async () => {
    await inRollback(async () => {
      await refused(input(`nobody-${tag()}@example.test`), /must already exist/);
      await refused(input((await person({ verified: false })).email), /must already exist/);
      await refused(input((await person({ deleted: true })).email), /deleted/);
      await refused(input((await person({ service: true })).email), /service account/);
    });
  });

  test("an existing slug is used only if it is this person's live client business, and a role is never changed", async () => {
    await inRollback(async () => {
      const paolo = await person();
      const someone = await person();
      const theirs = `theirs-${tag()}`;
      await q(`insert into organizations (type, name, slug, owner_user_id) values ('client', 'Theirs', $1, $2)`, [theirs, someone.id]);
      await refused(input(paolo.email, theirs), /someone else's/);
      const house = `house-${tag()}`;
      await q(`insert into organizations (type, name, slug) values ('internal', 'House', $1)`, [house]);
      await refused(input(paolo.email, house), /not a client business/);

      // His own, unrecorded, where he is only a member: not re-roled.
      const mine = `mine-${tag()}`;
      const mineId = (await q(`insert into organizations (type, name, slug) values ('client', 'Mine', $1) returning id`, [mine]))[0].id;
      await q(`insert into memberships (user_id, organization_id, role) values ($1, $2, 'member')`, [paolo.id, mineId]);
      await refused(input(paolo.email, mine), /roles are not changed/);
    });
  });

  test("refuses, and leaves nothing behind, when anybody else can reach the business", async () => {
    await inRollback(async () => {
      const paolo = await person();
      const someone = await person();
      const args = input(paolo.email);
      const { organizationId } = await provisionBusiness(owner, args);

      await owner.query("savepoint other_member");
      await q(`insert into memberships (user_id, organization_id, role) values ($1, $2, 'member')`, [someone.id, organizationId]);
      await refused(args, /other membership/);
      await owner.query("rollback to savepoint other_member");

      await owner.query("savepoint invitation");
      await q(
        `insert into invitations (email, organization_id, role, invited_by, expires_at) values ($1, $2, 'member', $3, now() + interval '7 days')`,
        [someone.email, organizationId, paolo.id],
      );
      await refused(args, /open invitation/);
      await owner.query("rollback to savepoint invitation");

      await owner.query("savepoint key");
      const robot = await person({ service: true });
      await q(
        `insert into api_keys (organization_id, service_user_id, label, key_hash, prefix, created_by) values ($1, $2, 'test', $3, 'tst', $4)`,
        [organizationId, robot.id, randomBytes(32), paolo.id],
      );
      await refused(args, /live API key/);
      await owner.query("rollback to savepoint key");

      await owner.query("savepoint host");
      await q(`insert into organization_domains (organization_id, hostname) values ($1, $2)`, [organizationId, `private-${tag()}.example.test`]);
      await refused(args, /hostname/);
      await owner.query("rollback to savepoint host");

      // With all of that gone again, it verifies.
      await expect(provisionBusiness(owner, args)).resolves.toMatchObject({ organizationId, createdMembership: false });
    });
  });
});
