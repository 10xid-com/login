import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";
import { closePool } from "@/lib/db/connection";
import {
  acceptInvitation,
  INVITATION_TTL_DAYS,
  inviteToOrganization,
  liveInvitationFor,
} from "@/lib/db/invitations";

/**
 * 0021: WorkOS is who signed in, and an account is tied to a WorkOS user once.
 *
 * Every rule here is meant to hold in the DATABASE, so each is provoked through
 * a raw connection as the role that matters: the application's restricted role
 * for what must be refused, the owner for what an operator may do. A rule that
 * held only because the application never tried would not be a rule.
 */

const run = promisify(execFile);
const owner = new Client({ connectionString: process.env.DATABASE_URL });
const app = new Client({ connectionString: process.env.DATABASE_APP_URL });

const TAG = `wb${Date.now().toString(36)}`;
const made: string[] = [];
let orgId = "";
let inviterId = "";

async function makeUser(label: string): Promise<string> {
  const { rows } = await owner.query(
    "insert into users (email) values ($1) returning id",
    [`${label}-${TAG}@test.invalid`],
  );
  made.push(rows[0].id);
  return rows[0].id;
}

function bindings(...args: string[]) {
  return run("node", ["scripts/identity-bindings.mjs", ...args], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
}

beforeAll(async () => {
  await owner.connect();
  await app.connect();
  const org = await owner.query(
    "insert into organizations (type, name, slug) values ('client', $1, $1) returning id",
    [`org-${TAG}`],
  );
  orgId = org.rows[0].id;
  inviterId = await makeUser("inviter");
});

afterAll(async () => {
  await owner.query("delete from identity_bindings where user_id = any($1::uuid[])", [made]);
  await owner.query("delete from memberships where user_id = any($1::uuid[])", [made]);
  await owner.query("delete from invitations where organization_id = $1", [orgId]);
  await owner.query("delete from user_emails where user_id = any($1::uuid[])", [made]);
  await owner.query("delete from users where id = any($1::uuid[])", [made]);
  await owner.query("delete from organizations where id = $1", [orgId]);
  await owner.end();
  await app.end();
  await closePool();
});

describe("users.workos_user_id", () => {
  test("the application role cannot bind an existing account", async () => {
    const id = await makeUser("nobind");
    await expect(
      app.query("update users set workos_user_id = $2 where id = $1", [id, `user_${TAG}_a`]),
    ).rejects.toThrow(/Only an operator binds/);
  });

  test("the application role may still update everything else on users", async () => {
    const id = await makeUser("other-cols");
    await app.query("update users set full_name = 'Still Writable' where id = $1", [id]);
    const { rows } = await owner.query("select full_name from users where id = $1", [id]);
    expect(rows[0].full_name).toBe("Still Writable");
  });

  test("the owner binds once, and then nobody re-points or clears it", async () => {
    const id = await makeUser("bindonce");
    await owner.query("update users set workos_user_id = $2 where id = $1", [id, `user_${TAG}_b`]);

    await expect(
      owner.query("update users set workos_user_id = $2 where id = $1", [id, `user_${TAG}_c`]),
    ).rejects.toThrow(/set once and never changed/);
    await expect(
      owner.query("update users set workos_user_id = null where id = $1", [id]),
    ).rejects.toThrow(/set once and never changed/);
  });

  test("one WorkOS user is one account", async () => {
    const a = await makeUser("uniq-a");
    const b = await makeUser("uniq-b");
    await owner.query("update users set workos_user_id = $2 where id = $1", [a, `user_${TAG}_d`]);
    await expect(
      owner.query("update users set workos_user_id = $2 where id = $1", [b, `user_${TAG}_d`]),
    ).rejects.toThrow(/users_workos_user_id_unique/);
  });

  test("an account created by accepting an invitation is born bound", async () => {
    const email = `invitee-${TAG}@test.invalid`;
    await inviteToOrganization({ organizationId: orgId, email, role: "owner", invitedBy: inviterId });
    const invitation = await liveInvitationFor(email);
    expect(invitation).not.toBeNull();

    const accepted = await acceptInvitation({
      invitationId: invitation!.id,
      organizationId: orgId,
      email,
      role: "owner",
      workosUserId: `user_${TAG}_e`,
    });
    expect(accepted).not.toBeNull();
    made.push(accepted!.userId);

    const { rows } = await owner.query("select workos_user_id from users where id = $1", [accepted!.userId]);
    expect(rows[0].workos_user_id).toBe(`user_${TAG}_e`);
  });

  test("invitations last seven days", async () => {
    expect(INVITATION_TTL_DAYS).toBe(7);
    const email = `ttl-${TAG}@test.invalid`;
    await inviteToOrganization({ organizationId: orgId, email, role: "viewer", invitedBy: inviterId });
    const { rows } = await owner.query(
      "select extract(epoch from expires_at - created_at) as s, role from invitations where email = $1",
      [email],
    );
    expect(Math.round(Number(rows[0].s) / 86400)).toBe(7);
    expect(rows[0].role).toBe("viewer");
  });
});

describe("identity_bindings", () => {
  test("the application role can ask but cannot answer or erase", async () => {
    const id = await makeUser("ask");
    const { rows } = await app.query(
      "insert into identity_bindings (user_id, workos_user_id, email) values ($1, $2, $3) returning id",
      [id, `user_${TAG}_f`, `ask-${TAG}@test.invalid`],
    );
    await expect(
      app.query(
        "update identity_bindings set decision = 'confirmed', decided_at = now(), decided_by = 'me' where id = $1",
        [rows[0].id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(app.query("delete from identity_bindings where id = $1", [rows[0].id])).rejects.toThrow(
      /permission denied/,
    );
  });

  test("one open request per account and per WorkOS user", async () => {
    const id = await makeUser("open-once");
    const other = await makeUser("open-other");
    await app.query("insert into identity_bindings (user_id, workos_user_id, email) values ($1, $2, $3)", [
      id,
      `user_${TAG}_g`,
      `open-once-${TAG}@test.invalid`,
    ]);
    await expect(
      app.query("insert into identity_bindings (user_id, workos_user_id, email) values ($1, $2, $3)", [
        id,
        `user_${TAG}_h`,
        `open-once-${TAG}@test.invalid`,
      ]),
    ).rejects.toThrow(/identity_bindings_one_open_per_user/);
    await expect(
      app.query("insert into identity_bindings (user_id, workos_user_id, email) values ($1, $2, $3)", [
        other,
        `user_${TAG}_g`,
        `open-other-${TAG}@test.invalid`,
      ]),
    ).rejects.toThrow(/identity_bindings_one_open_per_workos_user/);
  });

  test("an address is stored normalised or not at all", async () => {
    const id = await makeUser("case");
    await expect(
      app.query("insert into identity_bindings (user_id, workos_user_id, email) values ($1, $2, $3)", [
        id,
        `user_${TAG}_i`,
        `Case-${TAG}@Test.invalid`,
      ]),
    ).rejects.toThrow(/identity_bindings_email_lowercase/);
  });
});

describe("scripts/identity-bindings.mjs", () => {
  async function request(label: string, workos: string) {
    const id = await makeUser(label);
    const email = `${label}-${TAG}@test.invalid`;
    const { rows } = await app.query(
      "insert into identity_bindings (user_id, workos_user_id, email) values ($1, $2, $3) returning id",
      [id, workos, email],
    );
    return { userId: id, requestId: rows[0].id as string, email };
  }

  test("confirm binds the account and records who decided", async () => {
    const r = await request("confirm", `user_${TAG}_j`);
    const { stdout: listed } = await bindings("list");
    expect(listed).toContain(r.requestId);

    const { stdout } = await bindings("confirm", r.requestId, "--operator", "Test Operator");
    expect(stdout).toContain("Confirmed");

    const user = await owner.query("select workos_user_id from users where id = $1", [r.userId]);
    expect(user.rows[0].workos_user_id).toBe(`user_${TAG}_j`);
    const decided = await owner.query("select decision, decided_by from identity_bindings where id = $1", [
      r.requestId,
    ]);
    expect(decided.rows[0]).toEqual({ decision: "confirmed", decided_by: "Test Operator" });

    await expect(bindings("confirm", r.requestId, "--operator", "Again")).rejects.toThrow(
      /Already confirmed/,
    );
  });

  test("reject leaves the account unbound", async () => {
    const r = await request("reject", `user_${TAG}_k`);
    await bindings("reject", r.requestId, "--operator", "Test Operator");
    const user = await owner.query("select workos_user_id from users where id = $1", [r.userId]);
    expect(user.rows[0].workos_user_id).toBeNull();
  });

  test("an operator must be named", async () => {
    const r = await request("anon", `user_${TAG}_l`);
    await expect(bindings("confirm", r.requestId)).rejects.toThrow(/--operator/);
  });

  test("confirm refuses an address the account no longer holds", async () => {
    const r = await request("moved", `user_${TAG}_m`);
    await owner.query("update user_emails set email = $2 where user_id = $1", [
      r.userId,
      `moved-elsewhere-${TAG}@test.invalid`,
    ]);
    await expect(bindings("confirm", r.requestId, "--operator", "Test Operator")).rejects.toThrow(
      /no longer belongs/,
    );
    const user = await owner.query("select workos_user_id from users where id = $1", [r.userId]);
    expect(user.rows[0].workos_user_id).toBeNull();
  });
});
