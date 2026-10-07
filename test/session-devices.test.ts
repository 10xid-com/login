import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import {
  activeSessionsForUser,
  revokeOtherSessionsForUser,
  revokeOwnSession,
} from "@/lib/db/identity";
import { closePool } from "@/lib/db/connection";

/**
 * One browser, several sessions, one device.
 *
 * A browser signed in on the login host and handed to the portal holds a
 * session on each. Signing out "this device" has to end both — otherwise the
 * login host hands the browser straight back in on the next page — and the
 * login host's session is not one of this person's "other devices".
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const stamp = Date.now();
const users: string[] = [];

async function makeUser(email: string) {
  const { rows } = await owner.query(
    `insert into users (email, full_name) values ($1, $1) returning id`,
    [email],
  );
  users.push(rows[0].id);
  return rows[0].id as string;
}

async function makeSession(userId: string, host: string, source: string | null = null) {
  const { rows } = await owner.query(
    `insert into sessions
       (user_id, token_hash, issued_for_host, absolute_expires_at,
        role_at_creation, source_session_id)
     values ($1, decode(md5(random()::text), 'hex'), $2,
             now() + interval '1 day', 'client', $3)
     returning id`,
    [userId, host, source],
  );
  return rows[0].id as string;
}

async function live(ids: string[]) {
  const { rows } = await owner.query(
    `select id from sessions where id = any($1::uuid[]) and revoked_at is null`,
    [ids],
  );
  return new Set(rows.map((r) => r.id as string));
}

/** Two browsers for one person: each signed in on login, handed to app and a client domain. */
async function twoBrowsers(userId: string) {
  const laptop = await makeSession(userId, "login.test");
  const laptopApp = await makeSession(userId, "app.test", laptop);
  const laptopClient = await makeSession(userId, "client.test", laptop);
  const phone = await makeSession(userId, "login.test");
  const phoneApp = await makeSession(userId, "app.test", phone);
  return { laptop, laptopApp, laptopClient, phone, phoneApp };
}

beforeAll(async () => {
  await owner.connect();
});

afterAll(async () => {
  await owner.query(`delete from sessions where user_id = any($1::uuid[])`, [users]);
  await owner.query(`delete from user_emails where user_id = any($1::uuid[])`, [users]);
  await owner.query(`delete from users where id = any($1::uuid[])`, [users]);
  await owner.end();
  await closePool();
});

describe("signing out one device", () => {
  test("from the portal, ends the portal's session AND the login host's it came from", async () => {
    const me = await makeUser(`devices-a-${stamp}@devices.test`);
    const b = await twoBrowsers(me);

    expect(await revokeOwnSession(me, b.laptopApp)).toBe(true);

    const still = await live(Object.values(b));
    expect(still.has(b.laptop)).toBe(false);
    expect(still.has(b.laptopApp)).toBe(false);
    // Every other host that browser was handed to goes too: it is one device.
    expect(still.has(b.laptopClient)).toBe(false);
    // The phone is another device and is untouched.
    expect(still.has(b.phone)).toBe(true);
    expect(still.has(b.phoneApp)).toBe(true);
  });

  test("from the login host, ends every session that browser was handed", async () => {
    const me = await makeUser(`devices-b-${stamp}@devices.test`);
    const b = await twoBrowsers(me);

    await revokeOwnSession(me, b.phone);

    const still = await live(Object.values(b));
    expect(still.has(b.phone)).toBe(false);
    expect(still.has(b.phoneApp)).toBe(false);
    expect(still.has(b.laptop)).toBe(true);
    expect(still.has(b.laptopApp)).toBe(true);
  });

  test("a stranger's session id signs out nothing of theirs, and nothing of yours", async () => {
    const me = await makeUser(`devices-c-${stamp}@devices.test`);
    const them = await makeUser(`devices-d-${stamp}@devices.test`);
    const mine = await twoBrowsers(me);
    const theirs = await twoBrowsers(them);

    expect(await revokeOwnSession(me, theirs.laptopApp)).toBe(false);

    const still = await live([...Object.values(mine), ...Object.values(theirs)]);
    expect(still.size).toBe(10);
  });
});

describe("signing out every other device", () => {
  test("keeps all of this browser's sessions, the login host's included", async () => {
    const me = await makeUser(`devices-e-${stamp}@devices.test`);
    const b = await twoBrowsers(me);

    expect(await revokeOtherSessionsForUser(me, b.laptopApp)).toBe(2);

    const still = await live(Object.values(b));
    expect([...still].sort()).toEqual([b.laptop, b.laptopApp, b.laptopClient].sort());
  });
});

test("the list carries what is needed to group it by device", async () => {
  const me = await makeUser(`devices-f-${stamp}@devices.test`);
  const b = await twoBrowsers(me);

  const listed = await activeSessionsForUser(me);
  const deviceOf = (s: { id: string; sourceSessionId: string | null }) =>
    s.sourceSessionId ?? s.id;
  const devices = new Set(listed.map(deviceOf));
  expect(devices).toEqual(new Set([b.laptop, b.phone]));
});
