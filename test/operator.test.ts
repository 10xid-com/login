import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/**
 * 0023: the operator functions, as each role that matters. The login host's
 * sign-in role (portal_auth) may call them; the portal's role (portal_app)
 * may not, so a compromised portal cannot bind accounts or invite anybody.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const app = new Client({ connectionString: process.env.DATABASE_APP_URL });
const auth = new Client({ connectionString: process.env.AUTH_DATABASE_URL });
const TAG = `op${Date.now().toString(36)}`;
let orgId = "";
let operatorId = "";
const addr = (l: string) => `${l}-${TAG}@test.invalid`;

async function pendingBinding(label: string) {
  const email = addr(label);
  const u = await owner.query("insert into users (email) values ($1) returning id", [email]);
  const authUserId = `auth-${label}-${TAG}`;
  const b = await owner.query(
    "insert into identity_bindings (user_id, auth_user_id, email) values ($1, $2, $3) returning id",
    [u.rows[0].id, authUserId, email],
  );
  return { userId: u.rows[0].id as string, requestId: b.rows[0].id as string, authUserId, email };
}

beforeAll(async () => {
  await Promise.all([owner.connect(), app.connect(), auth.connect()]);
  orgId = (await owner.query("insert into organizations (type, name, slug) values ('client', $1, $1) returning id", [`op-${TAG}`])).rows[0].id;
  operatorId = (await owner.query("insert into users (email) values ($1) returning id", [addr("operator")])).rows[0].id;
});

afterAll(async () => {
  const like = `%-${TAG}@test.invalid`;
  await owner.query("delete from invitations where email like $1", [like]);
  await owner.query("delete from identity_bindings where email like $1", [like]);
  await owner.query("delete from user_emails where email like $1", [like]);
  await owner.query("delete from users where email like $1", [like]);
  await owner.query("delete from organizations where id = $1", [orgId]);
  await Promise.all([owner.end(), app.end(), auth.end()]);
});

describe("who may call them", () => {
  test("the portal's role may not", async () => {
    for (const call of [
      "select * from operator_open_bindings()",
      "select * from operator_client_businesses()",
      `select operator_decide_binding('${randomUUID()}', true, 'x')`,
      `select operator_invite('a@b.co', '${randomUUID()}', 'owner', '${randomUUID()}')`,
    ]) {
      await expect(app.query(call), call).rejects.toThrow(/permission denied/);
    }
  });

  test("the sign-in role may, and still cannot read the portal's tables directly", async () => {
    await expect(auth.query("select * from operator_client_businesses()")).resolves.toBeTruthy();
    await expect(auth.query("select 1 from users limit 1")).rejects.toThrow(/permission denied/);
  });
});

describe("deciding a binding", () => {
  test("confirm binds the account, once, and records who decided", async () => {
    const p = await pendingBinding("confirm");
    const listed = (await auth.query("select * from operator_open_bindings()")).rows;
    expect(listed.some((r) => r.id === p.requestId && r.account_email === p.email)).toBe(true);
    expect((await auth.query("select operator_decide_binding($1, true, 'Op Name') o", [p.requestId])).rows[0].o).toBe("confirmed");
    const u = await owner.query("select auth_user_id from users where id = $1", [p.userId]);
    expect(u.rows[0].auth_user_id).toBe(p.authUserId);
    const b = await owner.query("select decision, decided_by from identity_bindings where id = $1", [p.requestId]);
    expect(b.rows[0]).toEqual({ decision: "confirmed", decided_by: "Op Name" });
    expect((await auth.query("select operator_decide_binding($1, true, 'Op') o", [p.requestId])).rows[0].o).toBe("already_decided");
  });

  test("reject binds nothing", async () => {
    const p = await pendingBinding("reject");
    expect((await auth.query("select operator_decide_binding($1, false, 'Op') o", [p.requestId])).rows[0].o).toBe("rejected");
    expect((await owner.query("select auth_user_id from users where id = $1", [p.userId])).rows[0].auth_user_id).toBeNull();
  });

  test("an address the account no longer holds, or a sign-in already bound elsewhere, is refused", async () => {
    const p = await pendingBinding("moved");
    await owner.query("update user_emails set email = $2 where user_id = $1", [p.userId, addr("moved-new")]);
    expect((await auth.query("select operator_decide_binding($1, true, 'Op') o", [p.requestId])).rows[0].o).toBe("address_not_owned");

    const q = await pendingBinding("taken");
    await owner.query("update users set auth_user_id = $2 where id = $1", [operatorId, q.authUserId]);
    expect((await auth.query("select operator_decide_binding($1, true, 'Op') o", [q.requestId])).rows[0].o).toBe("identity_taken");
    await owner.query("update users set auth_user_id = null where id = $1", [operatorId]).catch(() => {});
  });

  test("an operator must be named", async () => {
    const p = await pendingBinding("anon");
    expect((await auth.query("select operator_decide_binding($1, true, '  ') o", [p.requestId])).rows[0].o).toBe("no_operator");
  });
});

describe("inviting", () => {
  test("into a live client business, lowercased, replacing an outstanding one", async () => {
    await auth.query("select operator_invite($1, $2, 'owner', $3)", [`  New-${TAG}@Test.Invalid `, orgId, operatorId]);
    await auth.query("select operator_invite($1, $2, 'viewer', $3)", [`new-${TAG}@test.invalid`, orgId, operatorId]);
    const rows = (await owner.query(
      "select role, revoked_at is null as live from invitations where email = $1 order by created_at",
      [`new-${TAG}@test.invalid`],
    )).rows;
    expect(rows).toEqual([{ role: "owner", live: false }, { role: "viewer", live: true }]);
  });

  test("refuses the house, a deleted business, legacy roles, bad addresses and unknown inviters", async () => {
    const house = (await owner.query("select id from organizations where type = 'internal' limit 1")).rows[0]?.id ?? randomUUID();
    const bad: [string, string, string, string][] = [
      [addr("x"), house, "owner", operatorId],
      [addr("x"), randomUUID(), "owner", operatorId],
      [addr("x"), orgId, "staff", operatorId],
      [addr("x"), orgId, "member", operatorId],
      ["not-an-address", orgId, "owner", operatorId],
      [addr("x"), orgId, "owner", randomUUID()],
    ];
    for (const args of bad) {
      await expect(auth.query("select operator_invite($1, $2, $3::membership_role, $4)", args), args.join(" ")).rejects.toThrow();
    }
  });
});
