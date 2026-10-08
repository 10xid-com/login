import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";

/**
 * 0025: agency grants, as the database enforces them — run as portal_app,
 * the role the portal connects as, so these are the rules a compromised or
 * mistaken portal still cannot get past.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const app = new Client({ connectionString: process.env.DATABASE_APP_URL });
const TAG = `ag${Date.now().toString(36)}`;
const addr = (l: string) => `${l}-${TAG}@test.invalid`;
const org: Record<string, string> = {};
const who: Record<string, string> = {};

async function organization(key: string, type: "client" | "internal" = "client") {
  org[key] = (
    await owner.query("insert into organizations (type, name, slug) values ($1, $2, $2) returning id", [type, `${TAG}-${key}`])
  ).rows[0].id;
}
async function person(key: string, memberships: [string, string][]) {
  who[key] = (await owner.query("insert into users (email) values ($1) returning id", [addr(key)])).rows[0].id;
  for (const [o, role] of memberships) {
    await owner.query("insert into memberships (user_id, organization_id, role) values ($1, $2, $3)", [who[key], org[o], role]);
  }
}
const err = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

async function request(by: string, client = "client", opts: { role?: string; days?: number; agency?: string } = {}) {
  const r = await app.query(
    `insert into agency_grants (client_organization_id, agency_organization_id, role, reason, duration_days, requested_by)
     values ($1, $2, $3, 'Website and print work', $4, $5) returning id`,
    [org[client], org[opts.agency ?? "agency"], opts.role ?? "editor", opts.days ?? 90, who[by]],
  );
  return r.rows[0].id as string;
}
const approve = (grant: string, by: string, days = 90, role?: string) =>
  app.query(
    `update agency_grants set status = 'active', decided_by = $2, expires_at = now() + make_interval(days => $3)
       ${role ? ", role = $4" : ""} where id = $1`,
    role ? [grant, who[by], days, role] : [grant, who[by], days],
  );
const grantRow = async (id: string) => (await owner.query("select * from agency_grants where id = $1", [id])).rows[0];
const membershipCount = async () =>
  Number((await owner.query("select count(*)::int as n from memberships where organization_id = any($1::uuid[])", [Object.values(org)])).rows[0].n);

let membershipsAtStart = 0;

beforeAll(async () => {
  await Promise.all([owner.connect(), app.connect()]);
  await organization("agency");
  await organization("client");
  await organization("other-client");
  await organization("not-agency");
  await organization("house", "internal");
  await owner.query("update organizations set is_agency = true where id = $1", [org.agency]);
  await person("agency-owner", [["agency", "owner"]]);
  await person("agency-editor", [["agency", "editor"]]);
  await person("agency-viewer", [["agency", "viewer"]]);
  await person("outsider-owner", [["not-agency", "owner"]]);
  await person("client-owner", [["client", "owner"]]);
  await person("client-manager", [["client", "manager"]]);
  await person("other-owner", [["other-client", "owner"]]);
  membershipsAtStart = await membershipCount();
});

afterAll(async () => {
  const ids = Object.values(org);
  await owner.query("delete from audit_events where organization_id = any($1::uuid[])", [ids]);
  await owner.query(
    "delete from agency_grant_people where grant_id in (select id from agency_grants where client_organization_id = any($1::uuid[]))",
    [ids],
  );
  await owner.query("delete from agency_grants where client_organization_id = any($1::uuid[])", [ids]);
  await owner.query("delete from memberships where organization_id = any($1::uuid[])", [ids]);
  await owner.query("delete from user_emails where email like $1", [`%-${TAG}@test.invalid`]);
  await owner.query("delete from users where email like $1", [`%-${TAG}@test.invalid`]);
  await owner.query("delete from organizations where id = any($1::uuid[])", [ids]);
  await Promise.all([owner.end(), app.end()]);
});

describe("which organizations are agencies", () => {
  test("the portal can neither make nor unmake an agency; the database owner can", async () => {
    expect(await err(app.query("update organizations set is_agency = true where id = $1", [org["not-agency"]]))).toMatch(
      /database owner decides/,
    );
    expect(await err(app.query("update organizations set is_agency = false where id = $1", [org.agency]))).toMatch(
      /database owner decides/,
    );
    expect(
      await err(app.query("insert into organizations (type, name, slug, is_agency) values ('client', $1, $1, true)", [`${TAG}-sneaky`])),
    ).toMatch(/database owner decides/);
  });
});

describe("asking for access", () => {
  test("an agency owner asks; it starts as a request with nothing decided", async () => {
    const id = await request("agency-owner");
    expect(await grantRow(id)).toMatchObject({ status: "requested", role: "editor", duration_days: 90, decided_by: null, expires_at: null });
  });

  test("one open request per business and agency", async () => {
    expect(await err(request("agency-owner"))).toMatch(/agency_grants_one_open_idx/);
  });

  test("refused: an agency editor, an organization that is not an agency, a business that is not a live client", async () => {
    expect(await err(request("agency-editor", "other-client"))).toMatch(/owner or manager of the agency/);
    expect(await err(request("outsider-owner", "other-client", { agency: "not-agency" }))).toMatch(/Only an agency/);
    expect(await err(request("agency-owner", "house"))).toMatch(/live client business/);
  });

  test("refused: owner as the role, or longer than a year", async () => {
    expect(await err(request("agency-owner", "other-client", { role: "owner" }))).toMatch(/agency_grants_role_template/);
    expect(await err(request("agency-owner", "other-client", { days: 400 }))).toMatch(/agency_grants_duration/);
  });

  test("a request cannot be pre-approved, or rewritten", async () => {
    expect(
      await err(
        app.query(
          `insert into agency_grants (client_organization_id, agency_organization_id, reason, requested_by, status, decided_by, decided_at, expires_at)
           values ($1, $2, 'Website and print work', $3, 'active', $4, now(), now() + interval '30 days')`,
          [org["other-client"], org.agency, who["agency-owner"], who["other-owner"]],
        ),
      ),
    ).toMatch(/starts as a request/);
    const [g] = (await owner.query("select id from agency_grants where client_organization_id = $1", [org.client])).rows;
    expect(await err(app.query("update agency_grants set duration_days = 365 where id = $1", [g.id]))).toMatch(/cannot be rewritten/);
    expect(await err(app.query("update agency_grants set reason = 'something else entirely' where id = $1", [g.id]))).toMatch(
      /cannot be rewritten/,
    );
  });
});

describe("approval", () => {
  test("only the business's owner approves — not its manager, not the agency, not another business", async () => {
    const [g] = (await owner.query("select id from agency_grants where client_organization_id = $1", [org.client])).rows;
    for (const by of ["client-manager", "agency-owner", "other-owner"]) {
      expect(await err(approve(g.id, by)), by).toMatch(/Only an owner of the business can approve/);
    }
  });

  test("no longer than was asked for", async () => {
    const [g] = (await owner.query("select id from agency_grants where client_organization_id = $1", [org.client])).rows;
    expect(await err(approve(g.id, "client-owner", 120))).toMatch(/no longer than was asked/);
  });

  test("approved by the owner: in force, with a clock, at a role the owner chose", async () => {
    const [g] = (await owner.query("select id from agency_grants where client_organization_id = $1", [org.client])).rows;
    expect(await err(approve(g.id, "client-owner", 90, "viewer"))).toBe("ok");
    const row = await grantRow(g.id);
    expect(row).toMatchObject({ status: "active", role: "viewer", decided_by: who["client-owner"] });
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
  });

  test("in force, it can be shortened but never widened: no longer, no other role", async () => {
    const [g] = (await owner.query("select id from agency_grants where client_organization_id = $1", [org.client])).rows;
    expect(await err(app.query("update agency_grants set expires_at = expires_at + interval '1 day' where id = $1", [g.id]))).toMatch(
      /only be shortened or ended/,
    );
    expect(await err(app.query("update agency_grants set role = 'manager' where id = $1", [g.id]))).toMatch(
      /only be shortened or ended/,
    );
    expect(await err(app.query("update agency_grants set expires_at = expires_at - interval '1 day' where id = $1", [g.id]))).toBe("ok");
  });
});

describe("agency people", () => {
  let grant = "";
  beforeAll(async () => {
    grant = (await owner.query("select id from agency_grants where client_organization_id = $1", [org.client])).rows[0].id;
  });
  const add = (user: string, by: string) =>
    app.query("insert into agency_grant_people (grant_id, user_id, added_by) values ($1, $2, $3) returning id", [grant, who[user], who[by]]);
  const decide = (user: string, status: string, by: string) =>
    app.query("update agency_grant_people set status = $3, decided_by = $4 where grant_id = $1 and user_id = $2", [
      grant,
      who[user],
      status,
      who[by],
    ]);
  const statusOf = async (user: string) =>
    (await owner.query("select status from agency_grant_people where grant_id = $1 and user_id = $2", [grant, who[user]])).rows[0]?.status;

  test("the agency names its own people; each one waits for the business", async () => {
    expect(await err(add("agency-editor", "agency-owner"))).toBe("ok");
    expect(await statusOf("agency-editor")).toBe("requested");
  });

  test("refused: naming someone outside the agency, or by someone who is not its owner or manager, or pre-approved", async () => {
    expect(await err(add("client-manager", "agency-owner"))).toMatch(/Only a member of the agency/);
    expect(await err(add("agency-viewer", "agency-editor"))).toMatch(/owner or manager of the agency/);
    expect(
      await err(
        app.query("insert into agency_grant_people (grant_id, user_id, added_by, status) values ($1, $2, $3, 'approved')", [
          grant,
          who["agency-viewer"],
          who["agency-owner"],
        ]),
      ),
    ).toMatch(/starts as a request/);
  });

  test("approval is the business owner's: not its manager, not the agency", async () => {
    expect(await err(decide("agency-editor", "approved", "client-manager"))).toMatch(/Only an owner of the business can approve/);
    expect(await err(decide("agency-editor", "approved", "agency-owner"))).toMatch(/Only an owner of the business can approve/);
    expect(await err(decide("agency-editor", "approved", "client-owner"))).toBe("ok");
    expect(await statusOf("agency-editor")).toBe("approved");
  });

  test("blocked by the business's manager; only its owner unblocks", async () => {
    expect(await err(decide("agency-editor", "blocked", "agency-owner"))).toMatch(/Only the business can decline or block/);
    expect(await err(decide("agency-editor", "blocked", "client-manager"))).toBe("ok");
    expect(await err(decide("agency-editor", "approved", "client-manager"))).toMatch(/Only an owner of the business can approve/);
    expect(await err(decide("agency-editor", "approved", "client-owner"))).toBe("ok");
  });

  test("a person can step off, and is then closed", async () => {
    expect(await err(add("agency-viewer", "agency-owner"))).toBe("ok");
    expect(await err(decide("agency-viewer", "removed", "agency-viewer"))).toBe("ok");
    expect(await err(decide("agency-viewer", "approved", "client-owner"))).toMatch(/is closed/);
  });
});

describe("ending access", () => {
  test("revoked by the business's manager; nothing reopens it", async () => {
    const [g] = (await owner.query("select id from agency_grants where client_organization_id = $1", [org.client])).rows;
    expect(
      await err(app.query("update agency_grants set status = 'revoked', revoked_by = $2 where id = $1", [g.id, who["outsider-owner"]])),
    ).toMatch(/Only the business or the agency can end/);
    expect(
      await err(app.query("update agency_grants set status = 'revoked', revoked_by = $2 where id = $1", [g.id, who["client-manager"]])),
    ).toBe("ok");
    expect(await grantRow(g.id)).toMatchObject({ status: "revoked", revoked_by: who["client-manager"] });
    expect(await err(approve(g.id, "client-owner"))).toMatch(/closed/);
    expect(
      await err(app.query("insert into agency_grant_people (grant_id, user_id, added_by) values ($1, $2, $3)", [g.id, who["agency-viewer"], who["agency-owner"]])),
    ).toMatch(/open grant/);
  });

  test("declined by the owner; the agency may then ask again", async () => {
    const id = await request("agency-owner", "other-client");
    expect(
      await err(app.query("update agency_grants set status = 'declined', decided_by = $2 where id = $1", [id, who["other-owner"]])),
    ).toBe("ok");
    expect(await err(request("agency-owner", "other-client"))).toBe("ok");
  });

  test("the agency may withdraw its own request", async () => {
    const [g] = (
      await owner.query("select id from agency_grants where client_organization_id = $1 and status = 'requested'", [org["other-client"]])
    ).rows;
    expect(
      await err(app.query("update agency_grants set status = 'revoked', revoked_by = $2 where id = $1", [g.id, who["agency-owner"]])),
    ).toBe("ok");
  });
});

describe("what grants never touch", () => {
  test("no membership was created anywhere by any of this", async () => {
    expect(await membershipCount()).toBe(membershipsAtStart);
  });
});

describe("the authenticator time, for the portal", () => {
  test("the portal can ask when a live sign-in last passed the authenticator; nothing else", async () => {
    const authUser = `auth-${TAG}`;
    await owner.query("insert into auth_users (id, name, email) values ($1, 'T', $2)", [authUser, addr("signin")]);
    await owner.query(
      "insert into auth_sessions (id, token, user_id, expires_at) values ($1, $1, $2, now() + interval '7 days')",
      [`s-${TAG}`, authUser],
    );
    try {
      const before = await app.query("select auth_session_verified_at($1) as at", [`s-${TAG}`]);
      expect(before.rows[0].at).toBeNull();
      await owner.query("update auth_sessions set mfa_verified_at = now() where id = $1", [`s-${TAG}`]);
      const after = await app.query("select auth_session_verified_at($1) as at", [`s-${TAG}`]);
      expect(after.rows[0].at).toBeInstanceOf(Date);
      expect((await app.query("select auth_session_verified_at('nope') as at")).rows[0].at).toBeNull();
      expect(await err(app.query("select 1 from auth_sessions limit 1"))).toMatch(/permission denied/);
    } finally {
      await owner.query("delete from auth_users where id = $1", [authUser]);
    }
  });
});

describe("audit events", () => {
  const scoped = async (orgId: string, fn: () => Promise<unknown>) => {
    await app.query("begin");
    try {
      await app.query("select set_config('app.org_id', $1, true)", [orgId]);
      return await fn();
    } finally {
      await app.query("commit").catch(() => app.query("rollback"));
    }
  };

  test("one business's record, written and read only as that business, and never rewritten", async () => {
    await scoped(org.client!, () =>
      app.query("insert into audit_events (organization_id, actor_user_id, action) values ($1, $2, 'test.event')", [org.client, who["client-owner"]]),
    );
    expect(
      await err(
        scoped(org.client!, () =>
          app.query("insert into audit_events (organization_id, action) values ($1, 'test.event')", [org["other-client"]]),
        ),
      ),
    ).toMatch(/row-level security/);
    const seen = (await scoped(org["other-client"]!, () =>
      app.query("select count(*)::int as n from audit_events where organization_id = $1", [org.client]),
    )) as { rows: { n: number }[] };
    expect(seen.rows[0]!.n).toBe(0);
    expect(await err(scoped(org.client!, () => app.query("update audit_events set action = 'x'")))).toMatch(/permission denied/);
    expect(await err(scoped(org.client!, () => app.query("delete from audit_events")))).toMatch(/permission denied/);
  });
});
