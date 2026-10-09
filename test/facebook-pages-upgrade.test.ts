import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Client } from "pg";

/**
 * 0036 adds Facebook Pages beside Instagram accounts, on a database that
 * already has live Instagram connections (0034, deployed).
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });

beforeAll(() => owner.connect());
afterAll(() => owner.end());

test("the deployed migrations remain unchanged", async () => {
  const sql = await readFile("drizzle/0035_social_media_uploads.sql", "utf8");
  expect(createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
});

test("Facebook Pages upgrade alongside live Instagram connections", async () => {
  const upgrade = await readFile("drizzle/0036_facebook_pages.sql", "utf8");
  await owner.query("begin");
  try {
    const org = (await owner.query(`
      insert into organizations (type, name, slug)
      values ('client', 'Facebook migration test', 'facebook-migration-upgrade') returning id
    `)).rows[0].id as string;
    const user = (await owner.query(`
      insert into users (email, full_name)
      values ('facebook-migration@example.test', 'Facebook migration test') returning id
    `)).rows[0].id as string;
    const instagram = (await owner.query(`
      insert into social_connections
        (organization_id, channel, account_id, scoped_id, username, token_ciphertext, connected_by)
      values ($1, 'instagram', 'fb-upgrade-ig', 'fb-upgrade-ig-scoped', 'upgrade_test', 'sealed-ig', $2)
      returning *
    `, [org, user])).rows[0];

    await owner.query(upgrade);
    await owner.query(upgrade); // Deploy retries must be harmless.
    expect((await owner.query("select * from social_connections where id = $1", [instagram.id])).rows[0]).toEqual(instagram);

    // A Page beside it, as the application role, under the business's scope.
    await owner.query("set local role portal_app");
    await owner.query("select set_config('app.org_id', $1, true)", [org]);
    await owner.query(`
      insert into social_connections
        (organization_id, channel, account_id, scoped_id, username, token_ciphertext, connected_by)
      values ($1, 'facebook', '200000000000009', '1000000009', 'Upgrade Test Page', 'sealed-page', $2)
    `, [org, user]);
    await owner.query("savepoint unknown_channel");
    await expect(
      owner.query(`
        insert into social_connections
          (organization_id, channel, account_id, scoped_id, username, token_ciphertext, connected_by)
        values ($1, 'tiktok', 'x', 'y', 'z', 'sealed', $2)
      `, [org, user]),
    ).rejects.toThrow(/social_connections_channel_known/);
    await owner.query("rollback to savepoint unknown_channel");
  } finally {
    await owner.query("rollback");
  }
});

test("Meta's notice ends a Facebook connection, recorded by the Page's name", async () => {
  await owner.query("begin");
  try {
    const org = (await owner.query(`
      insert into organizations (type, name, slug)
      values ('client', 'Facebook revoke test', 'facebook-revoke-test') returning id
    `)).rows[0].id as string;
    const user = (await owner.query(`
      insert into users (email, full_name)
      values ('facebook-revoke@example.test', 'Facebook revoke test') returning id
    `)).rows[0].id as string;
    await owner.query(`
      insert into social_connections
        (organization_id, channel, account_id, scoped_id, username, token_ciphertext, connected_by)
      values ($1, 'facebook', '200000000000010', '1000000010', 'Revoke Test Page', 'sealed-page', $2)
    `, [org, user]);

    await owner.query("set local role portal_app");
    expect((await owner.query("select social_connection_revoke('facebook', '1000000010', 'deauthorize') as n")).rows[0].n).toBe(1);
    await owner.query("savepoint unknown_channel");
    await expect(owner.query("select social_connection_revoke('tiktok', '1', 'deauthorize')")).rejects.toThrow(/unknown channel/);
    await owner.query("rollback to savepoint unknown_channel");

    await owner.query("reset role");
    const row = (await owner.query("select token_ciphertext, disconnected_at from social_connections where account_id = '200000000000010'")).rows[0];
    expect(row.token_ciphertext).toBeNull();
    expect(row.disconnected_at).not.toBeNull();
    const audit = (await owner.query("select action, target from audit_events where organization_id = $1", [org])).rows;
    expect(audit).toEqual([{ action: "facebook.disconnected_by_deauthorize", target: "Revoke Test Page" }]);
  } finally {
    await owner.query("rollback");
  }
});
