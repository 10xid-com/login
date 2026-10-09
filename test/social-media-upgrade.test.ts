import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Client } from "pg";

const owner = new Client({ connectionString: process.env.DATABASE_URL });

beforeAll(() => owner.connect());
afterAll(() => owner.end());

test("the deployed photo migration remains unchanged", async () => {
  const sql = await readFile("drizzle/0034_social_connections.sql", "utf8");
  // Normalize checkout line endings, including on Windows.
  expect(createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex")).toBe(
    "fa869062d5bfc917c34c3fce303e34addcc9c5e9ed1db9974ebac128df975396",
  );
});

test("video uploads upgrade alongside live connections and legacy photos", async () => {
  const upgrade = await readFile("drizzle/0035_social_media_uploads.sql", "utf8");
  await owner.query("begin");
  try {
    // Recreate the deployed 0034 state, without changing the shared fixtures.
    await owner.query("drop table social_media_uploads");
    const org = (await owner.query(`
      insert into organizations (type, name, slug)
      values ('client', 'Video migration test', 'video-migration-upgrade') returning id
    `)).rows[0].id as string;
    const user = (await owner.query(`
      insert into users (email, full_name)
      values ('video-migration@example.test', 'Video migration test') returning id
    `)).rows[0].id as string;
    const hash = randomBytes(32).toString("hex");
    const photo = Buffer.from([255, 216, 255]);
    await owner.query(`
      insert into social_media (organization_id, uploaded_by, token_hash, content_type, bytes, width, height)
      values ($1, $2, $3, 'image/jpeg', $4, 1080, 1080)
    `, [org, user, hash, photo]);
    const connection = (await owner.query(`
      insert into social_connections
        (organization_id, channel, account_id, scoped_id, username, token_ciphertext, connected_by)
      values ($1, 'instagram', 'video-migration-test', 'video-migration-scoped', 'upgrade_test', 'sealed-test-token', $2)
      returning *
    `, [org, user])).rows[0];

    await owner.query(upgrade);
    await owner.query(upgrade); // Deploy retries must be harmless.
    expect((await owner.query("select * from social_connections where id = $1", [connection.id])).rows[0]).toEqual(connection);
    expect((await owner.query("select bytes from social_media_public($1)", [hash])).rows[0].bytes).toEqual(photo);

    await owner.query("set local role portal_app");
    await owner.query("select set_config('app.org_id', $1, true)", [org]);
    const key = `social/${org}/${randomBytes(24).toString("base64url")}.mp4`;
    const upload = (await owner.query(`
      insert into social_media_uploads
        (organization_id, uploaded_by, kind, content_type, storage_key, byte_size, duration_ms, upload_id)
      values ($1, $2, 'video', 'video/mp4', $3, 1024, 4000, 'multipart-test') returning id
    `, [org, user, key])).rows[0].id;
    await owner.query("update social_media_uploads set ready = true, upload_id = null where id = $1", [upload]);
    expect((await owner.query("select ready from social_media_uploads where id = $1", [upload])).rows[0].ready).toBe(true);

    await owner.query("select set_config('app.org_id', '', true)");
    expect((await owner.query("select id from social_media_uploads where id = $1", [upload])).rowCount).toBe(0);
    await owner.query("select set_config('app.org_id', $1, true)", [org]);
    expect((await owner.query("delete from social_media_uploads where id = $1 returning id", [upload])).rowCount).toBe(1);
  } finally {
    await owner.query("rollback");
  }
});
