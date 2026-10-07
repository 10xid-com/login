import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { startActingAs, stopActingAs } from "@/lib/auth/act-as";
import {
  actAsHistoryForActor,
  listActAsCandidates,
  liveActAsGrantForSession,
} from "@/lib/db/identity";
import { grant, revoke } from "@/lib/db/access";
import { createJob, listJobEvents, type Scope } from "@/lib/db";
import { closePool } from "@/lib/db/connection";
import {
  ACT_AS_GRANT_SECONDS,
  ACT_AS_STAFF_CAPABILITY,
} from "@/lib/auth/policy";

/**
 * Acting as somebody else, tested as the four properties rather than as a
 * feature.
 *
 * The distinction matters. "Can Paolo become Joel" is one click and proves
 * almost nothing; what separates a test tool from a back door is the set of
 * things it REFUSES, and every one of those is a path nobody exercises by
 * hand. So each refusal gets a test, and each one asserts that nothing was
 * written as well as that the answer was no — a rule that says no and files a
 * row anyway is not a rule.
 *
 * The decisions live in lib/auth/act-as.ts precisely so they can be reached
 * from here without a browser, a cookie or a redirect. The server action in
 * app/act-as/actions.ts holds no rule of its own; what it does hold is the
 * choice of WHICH identity to pass in, and the last test in this file reads
 * that off disk, because passing `ctx.userId` where `ctx.realUserId` belongs
 * would hand a staff session a way to launder itself into a client one and no
 * behavioural test would notice.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });

const stamp = Date.now();
let internalOrg = "";
let clientOrg = "";
let paolo = "";        // staff, and the one granted the capability
let otherStaff = "";   // staff with no capability
let joel = "";         // an ordinary client account
let colleague = "";    // a second staff account, the staff TARGET
let machine = "";      // a service account
let paoloSession = "";
let otherStaffSession = "";
let clientSession = "";

async function makeUser(
  email: string,
  opts: { isStaff?: boolean; isService?: boolean } = {},
) {
  const { rows } = await owner.query(
    `insert into users (email, full_name, is_staff, is_service)
     values ($1, $2, $3, $4) returning id`,
    [email, email.split("@")[0], opts.isStaff ?? false, opts.isService ?? false],
  );
  return rows[0].id as string;
}

async function makeSession(userId: string, role: string) {
  const { rows } = await owner.query(
    `insert into sessions
       (user_id, token_hash, issued_for_host, absolute_expires_at,
        role_at_creation, second_factor_at)
     values ($1, decode(md5(random()::text), 'hex'), 'act-as.test',
             now() + interval '1 day', $2, now())
     returning id`,
    [userId, role],
  );
  return rows[0].id as string;
}

/** The request a fully-authenticated staff session would make. */
const asPaolo = (targetUserId: string, reason = "checking the client view") => ({
  sessionId: paoloSession,
  realUserId: paolo,
  realIsStaff: true,
  needsSecondFactor: false,
  actingAsUserId: null,
  targetUserId,
  reason,
});

async function grantCount() {
  const { rows } = await owner.query(
    `select count(*)::int as n from act_as_grants where actor_user_id = any($1::uuid[])`,
    [[paolo, otherStaff, joel]],
  );
  return rows[0].n as number;
}

beforeAll(async () => {
  await owner.connect();

  const mkOrg = async (type: string, name: string, slug: string) =>
    (
      await owner.query(
        `insert into organizations (type, name, slug) values ($1,$2,$3) returning id`,
        [type, name, slug],
      )
    ).rows[0].id as string;

  internalOrg = await mkOrg("internal", "Act-as House", `actas-house-${stamp}`);
  clientOrg = await mkOrg("client", "Act-as Client", `actas-client-${stamp}`);

  paolo = await makeUser(`paolo-actas-${stamp}@test.invalid`, { isStaff: true });
  otherStaff = await makeUser(`peter-actas-${stamp}@test.invalid`, { isStaff: true });
  colleague = await makeUser(`colleague-actas-${stamp}@test.invalid`, { isStaff: true });
  joel = await makeUser(`joel-actas-${stamp}@test.invalid`);
  machine = await makeUser(`machine-actas-${stamp}@test.invalid`, { isService: true });

  for (const u of [paolo, otherStaff, colleague]) {
    await owner.query(
      `insert into memberships (user_id, organization_id, role) values ($1,$2,'staff')`,
      [u, internalOrg],
    );
  }
  await owner.query(
    `insert into memberships (user_id, organization_id, role) values ($1,$2,'owner')`,
    [joel, clientOrg],
  );

  paoloSession = await makeSession(paolo, "staff");
  otherStaffSession = await makeSession(otherStaff, "staff");
  clientSession = await makeSession(joel, "client");
});

afterAll(async () => {
  const users = [paolo, otherStaff, colleague, joel, machine].filter(Boolean);
  const orgs = [internalOrg, clientOrg].filter(Boolean);
  await owner.query(`delete from job_events where organization_id = any($1::uuid[])`, [orgs]);
  await owner.query(`delete from jobs where organization_id = any($1::uuid[])`, [orgs]);
  await owner.query(`delete from act_as_grants where actor_user_id = any($1::uuid[])`, [users]);
  await owner.query(`delete from sessions where user_id = any($1::uuid[])`, [users]);
  await owner.query(`delete from permissions where organization_id = any($1::uuid[])`, [orgs]);
  await owner.query(`delete from memberships where user_id = any($1::uuid[])`, [users]);
  await owner.query(`delete from user_emails where user_id = any($1::uuid[])`, [users]);
  await owner.query(`delete from users where id = any($1::uuid[])`, [users]);
  await owner.query(`delete from organizations where id = any($1::uuid[])`, [orgs]);
  await owner.end();
  await closePool();
});

/* ------------------------------------------------------------------ */

describe("who may start one at all", () => {
  test("a client session cannot, and writes nothing", async () => {
    const before = await grantCount();
    const result = await startActingAs({
      sessionId: clientSession,
      realUserId: joel,
      realIsStaff: false,
      needsSecondFactor: false,
      actingAsUserId: null,
      targetUserId: paolo,
      reason: "I would like to be an administrator",
    });

    expect(result).toEqual({ ok: false, refusal: "not_staff" });
    expect(await grantCount()).toBe(before);
    expect(await liveActAsGrantForSession(clientSession)).toBeNull();
  });

  test("a staff session that has not passed its second step cannot", async () => {
    const before = await grantCount();
    const result = await startActingAs({
      ...asPaolo(joel),
      needsSecondFactor: true,
    });
    expect(result).toEqual({ ok: false, refusal: "second_factor" });
    expect(await grantCount()).toBe(before);
  });

  test("a reason shorter than the floor is refused, and nothing is written", async () => {
    const before = await grantCount();
    expect(await startActingAs(asPaolo(joel, "test"))).toEqual({
      ok: false,
      refusal: "reason",
    });
    // Whitespace does not make a reason either.
    expect(await startActingAs(asPaolo(joel, "         "))).toEqual({
      ok: false,
      refusal: "reason",
    });
    expect(await grantCount()).toBe(before);
  });

  test("you cannot become yourself, or a service account", async () => {
    expect(await startActingAs(asPaolo(paolo))).toEqual({
      ok: false,
      refusal: "self",
    });
    expect(await startActingAs(asPaolo(machine))).toEqual({
      ok: false,
      refusal: "service_account",
    });
  });

  test("staff can act as a client account, and the row carries the reason", async () => {
    const result = await startActingAs(
      asPaolo(joel, "checking what Joel sees on the jobs list"),
    );
    expect(result.ok).toBe(true);

    const live = await liveActAsGrantForSession(paoloSession);
    expect(live?.targetUserId).toBe(joel);
    expect(live?.actorUserId).toBe(paolo);
    expect(live?.reason).toBe("checking what Joel sees on the jobs list");
    expect(live?.endedAt).toBeNull();

    // Sixty minutes, within a second either way of the constant.
    const minutes =
      (live!.expiresAt.getTime() - live!.startedAt.getTime()) / 1000;
    expect(Math.abs(minutes - ACT_AS_GRANT_SECONDS)).toBeLessThan(2);

    await stopActingAs(paoloSession);
  });
});

/* ------------------------------------------------------------------ */

describe("the picker", () => {
  /**
   * This query is here because it broke in the browser and nowhere else: the
   * correlated subquery that lists somebody's companies referred to the outer
   * table by a bare column name, which Postgres rejects as ambiguous at RUN
   * time. It typechecked, it built, and it 500'd on the first real page load.
   */
  test("lists people with their companies, and leaves service accounts out", async () => {
    const people = await listActAsCandidates();
    const byId = new Map(people.map((p) => [p.id, p]));

    expect(byId.get(machine)).toBeUndefined();
    expect(byId.get(joel)?.organizations).toContain("Act-as Client");
    expect(byId.get(paolo)?.organizations).toContain("Act-as House");
    // The flag the picker marks staff with, straight off the row.
    expect(byId.get(colleague)?.isStaff).toBe(true);
    expect(byId.get(joel)?.isStaff).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("targeting a staff account needs the capability", () => {
  test("a staff session without it is refused", async () => {
    const before = await grantCount();
    const result = await startActingAs({
      sessionId: otherStaffSession,
      realUserId: otherStaff,
      realIsStaff: true,
      needsSecondFactor: false,
      actingAsUserId: null,
      targetUserId: colleague,
      reason: "wanting a look at a colleague's screen",
    });

    expect(result).toEqual({ ok: false, refusal: "needs_capability" });
    expect(await grantCount()).toBe(before);
    expect(await liveActAsGrantForSession(otherStaffSession)).toBeNull();
  });

  test("the same session may still act as a CLIENT — the gate is on staff targets only", async () => {
    const result = await startActingAs({
      sessionId: otherStaffSession,
      realUserId: otherStaff,
      realIsStaff: true,
      needsSecondFactor: false,
      actingAsUserId: null,
      targetUserId: joel,
      reason: "reproducing what Joel reported this morning",
    });
    expect(result.ok).toBe(true);
    await stopActingAs(otherStaffSession);
  });

  test("granting the capability lets them through; revoking it shuts it again", async () => {
    await grant({
      organizationId: internalOrg,
      userId: otherStaff,
      capability: ACT_AS_STAFF_CAPABILITY,
      grantedBy: paolo,
    });

    const allowed = await startActingAs({
      sessionId: otherStaffSession,
      realUserId: otherStaff,
      realIsStaff: true,
      needsSecondFactor: false,
      actingAsUserId: null,
      targetUserId: colleague,
      reason: "checking a colleague's view of the survey",
    });
    expect(allowed.ok).toBe(true);
    expect((await liveActAsGrantForSession(otherStaffSession))?.targetUserId).toBe(
      colleague,
    );
    await stopActingAs(otherStaffSession);

    // "Until further notice" is one UPDATE, not a deploy.
    expect(
      await revoke({
        organizationId: internalOrg,
        userId: otherStaff,
        capability: ACT_AS_STAFF_CAPABILITY,
      }),
    ).toBe(1);

    expect(
      await startActingAs({
        sessionId: otherStaffSession,
        realUserId: otherStaff,
        realIsStaff: true,
        needsSecondFactor: false,
        actingAsUserId: null,
        targetUserId: colleague,
        reason: "checking a colleague's view of the survey",
      }),
    ).toEqual({ ok: false, refusal: "needs_capability" });
  });

  test("the capability is only honoured in an INTERNAL organization", async () => {
    // Granted inside the CLIENT company, where Joel is the owner. A client
    // company must not be able to hand out power over the house's own staff.
    await grant({
      organizationId: clientOrg,
      userId: otherStaff,
      capability: ACT_AS_STAFF_CAPABILITY,
      grantedBy: joel,
    });

    expect(
      await startActingAs({
        sessionId: otherStaffSession,
        realUserId: otherStaff,
        realIsStaff: true,
        needsSecondFactor: false,
        actingAsUserId: null,
        targetUserId: colleague,
        reason: "trying the side door into a staff account",
      }),
    ).toEqual({ ok: false, refusal: "needs_capability" });
  });

  test("a target whose is_staff flag has drifted is still treated as staff", async () => {
    // The stored flag and the membership can disagree — 0013 exists to find
    // out how often. Either one being true must cost the extra permission, so
    // a drifted flag can never be the thing that skips a check.
    await owner.query(`update users set is_staff = false where id = $1`, [colleague]);
    try {
      expect(
        await startActingAs({
          sessionId: otherStaffSession,
          realUserId: otherStaff,
          realIsStaff: true,
          needsSecondFactor: false,
          actingAsUserId: null,
          targetUserId: colleague,
          reason: "the flag says client but the membership says house",
        }),
      ).toEqual({ ok: false, refusal: "needs_capability" });
    } finally {
      await owner.query(`update users set is_staff = true where id = $1`, [colleague]);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("no chaining", () => {
  test("from inside Joel you cannot become anybody else", async () => {
    expect((await startActingAs(asPaolo(joel, "starting with Joel"))).ok).toBe(true);

    const before = await grantCount();
    expect(
      await startActingAs({
        ...asPaolo(colleague, "and now the colleague, please"),
        actingAsUserId: joel,
      }),
    ).toEqual({ ok: false, refusal: "chaining" });

    expect(await grantCount()).toBe(before);
    // Still Joel, and not somebody half-way between the two.
    expect((await liveActAsGrantForSession(paoloSession))?.targetUserId).toBe(joel);
  });

  test("renewing the SAME person is allowed, and writes a second row with its own reason", async () => {
    const renewed = await startActingAs({
      ...asPaolo(joel, "another hour on the same reproduction"),
      actingAsUserId: joel,
    });
    expect(renewed.ok).toBe(true);

    const live = await liveActAsGrantForSession(paoloSession);
    expect(live?.reason).toBe("another hour on the same reproduction");

    const history = await actAsHistoryForActor(paolo, 10);
    const forJoel = history.filter((h) => h.targetUserId === joel);
    expect(forJoel.length).toBeGreaterThanOrEqual(2);
    // Each stretch keeps its own reason rather than one row quietly growing.
    expect(new Set(forJoel.map((h) => h.reason)).size).toBeGreaterThanOrEqual(2);
  });

  test("stopping ends EVERY live grant on the session, not only the newest", async () => {
    const ended = await stopActingAs(paoloSession);
    expect(ended).toBeGreaterThanOrEqual(2);
    expect(await liveActAsGrantForSession(paoloSession)).toBeNull();

    // And the rows are still there, still carrying their reasons.
    const { rows } = await owner.query(
      `select count(*)::int as n from act_as_grants
        where session_id = $1 and ended_at is not null`,
      [paoloSession],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */

describe("the clock", () => {
  test("a grant past its hour stops working, with nothing having to notice", async () => {
    await owner.query(
      `insert into act_as_grants
         (session_id, actor_user_id, target_user_id, reason, started_at, expires_at)
       values ($1, $2, $3, 'an hour ago, and long finished',
               now() - interval '2 hours', now() - interval '1 hour')`,
      [paoloSession, paolo, joel],
    );

    expect(await liveActAsGrantForSession(paoloSession)).toBeNull();
  });

  test("a grant on another session is not this session's", async () => {
    expect((await startActingAs(asPaolo(joel, "only on this session"))).ok).toBe(true);
    expect(await liveActAsGrantForSession(otherStaffSession)).toBeNull();
    await stopActingAs(paoloSession);
  });
});

/* ------------------------------------------------------------------ */

describe("the database keeps the record honest", () => {
  test("nobody can be themselves, whatever the caller says", async () => {
    await expect(
      owner.query(
        `insert into act_as_grants (session_id, actor_user_id, target_user_id, reason, expires_at)
         values ($1,$2,$2,'being my own self here', now() + interval '1 hour')`,
        [paoloSession, paolo],
      ),
    ).rejects.toThrow(/act_as_grants_not_self/);
  });

  test("a reason is not optional and not a keystroke", async () => {
    await expect(
      owner.query(
        `insert into act_as_grants (session_id, actor_user_id, target_user_id, reason, expires_at)
         values ($1,$2,$3,'  .  ', now() + interval '1 hour')`,
        [paoloSession, paolo, joel],
      ),
    ).rejects.toThrow(/act_as_grants_reason_present/);
  });

  test("the application role cannot erase an impersonation", async () => {
    const { rows } = await owner.query(
      `select has_table_privilege('portal_app', 'act_as_grants', 'delete') as can_delete,
              has_table_privilege('portal_app', 'act_as_grants', 'select') as can_read,
              has_table_privilege('portal_app', 'act_as_grants', 'insert') as can_write,
              has_table_privilege('portal_app', 'act_as_grants', 'update') as can_end`,
    );
    expect(rows[0]).toEqual({
      can_delete: false,
      can_read: true,
      can_write: true,
      can_end: true,
    });
  });

  test("half a record of who was at the keyboard is refused", async () => {
    const { rows } = await owner.query(
      `insert into jobs (id, organization_id, ref, direction, title, created_by)
       values (gen_random_uuid(), $1, 'ACT-9001', 'to_client', 'constraint fixture', $2)
       returning id`,
      [clientOrg, joel],
    );
    const jobId = rows[0].id as string;

    // A real actor with no address beside them, and no grant to reach the
    // reason through, is half a record — worse than none, because it looks
    // like one. The database refuses it rather than trusting every writer.
    await expect(
      owner.query(
        `insert into job_events
           (job_id, organization_id, actor_id, actor_email_at_time, action, real_actor_id)
         values ($1,$2,$3,'joel@test.invalid','created',$4)`,
        [jobId, clientOrg, joel, paolo],
      ),
    ).rejects.toThrow(/job_events_real_actor_complete/);
  });
});

/* ------------------------------------------------------------------ */

describe("every write records both identities", () => {
  const baseScope: Omit<Scope, "actingAs"> = {
    userId: "",
    email: "",
    isStaff: false,
    organizationId: "",
  };

  test("ordinary work leaves the real-actor columns null, and null means real work", async () => {
    const scope: Scope = {
      ...baseScope,
      userId: joel,
      email: `joel-actas-${stamp}@test.invalid`,
      organizationId: clientOrg,
    };

    const job = await createJob(scope, {
      title: "Joel's own job",
      direction: "from_client",
    });
    const [event] = await listJobEvents(scope, job.id);

    expect(event.actorId).toBe(joel);
    expect(event.realActorId).toBeNull();
    expect(event.realActorEmailAtTime).toBeNull();
    expect(event.actAsGrantId).toBeNull();
  });

  test("work done while acting as somebody names both people and the grant", async () => {
    const started = await startActingAs(
      asPaolo(joel, "filing the job Joel could not file himself"),
    );
    expect(started.ok).toBe(true);
    const grantId = started.ok ? started.grantId : "";

    // Exactly the scope getSessionContext() builds while a grant is live: the
    // effective identity is the target, and actingAs carries the truth.
    const scope: Scope = {
      userId: joel,
      email: `joel-actas-${stamp}@test.invalid`,
      isStaff: false,
      organizationId: clientOrg,
      actingAs: {
        grantId,
        realUserId: paolo,
        realEmail: `paolo-actas-${stamp}@test.invalid`,
      },
    };

    const job = await createJob(scope, {
      title: "filed while acting as Joel",
      direction: "from_client",
    });
    const [event] = await listJobEvents(scope, job.id);

    // The work reads as Joel's, because that is who it was done as.
    expect(event.actorId).toBe(joel);
    // And the record says who was really there, and under which grant.
    expect(event.realActorId).toBe(paolo);
    expect(event.realActorEmailAtTime).toBe(`paolo-actas-${stamp}@test.invalid`);
    expect(event.actAsGrantId).toBe(grantId);

    // Which reaches the reason, six months later, by one join.
    const { rows } = await owner.query(
      `select g.reason
         from job_events e
         join act_as_grants g on g.id = e.act_as_grant_id
        where e.job_id = $1`,
      [job.id],
    );
    expect(rows[0].reason).toBe("filing the job Joel could not file himself");

    await stopActingAs(paoloSession);
  });
});

/* ------------------------------------------------------------------ */

describe("no permanent takeover: the guard is on every route that could be one", () => {
  /**
   * Read off disk, not asserted by hand.
   *
   * The routes that could hand an account over are the ones that still have
   * effect after the hour is up: the address a code is sent to, the
   * authenticator, the recovery codes, and the account's other sessions. A
   * list of them typed into this test would be correct today and stale the
   * first time somebody adds an email-change screen — which is exactly the
   * route that does not exist yet and is most likely to arrive next. So the
   * directories are walked instead, and anything new inside them has to carry
   * the guard or fail here.
   */
  const ROOTS = [
    "app/account",
    "app/auth/2fa",
    "app/auth/recovery-codes",
  ];

  /** Named individually: these are not account security, but they file audit
   * rows with a single identity column, so they refuse too. */
  const SINGLE_IDENTITY_AUDIT = [
    "app/staff/actions.ts",
    "app/team/actions.ts",
    "app/staff/keys/actions.ts",
  ];

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry) ? [full] : [];
    });
  }

  const guarded = (file: string) => {
    const src = readFileSync(file, "utf8");
    return (
      src.includes("requireOwnAccount") || src.includes("refuseWhileActingAs")
    );
  };

  test("every file under the account-security roots refuses an act-as session", () => {
    const files = ROOTS.flatMap(walk);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => !guarded(f))).toEqual([]);
  });

  test("the single-identity audit routes refuse it too", () => {
    expect(SINGLE_IDENTITY_AUDIT.filter((f) => !guarded(f))).toEqual([]);
  });

  test("the guard itself is one function, not a copied condition", () => {
    const src = readFileSync("lib/auth/require.ts", "utf8");
    expect(src).toContain("export function refuseWhileActingAs");
    expect(src).toContain('redirect("/act-as?error=blocked")');
  });

  test("signing out ends the REAL person's sessions, never the target's", () => {
    // Acting as Joel, `ctx.userId` IS Joel. The unchanged line would have
    // signed him out of every device he owns because somebody else pressed a
    // button in a window wearing his name.
    const src = readFileSync("app/auth/actions.ts", "utf8");
    expect(src).toContain("signOutEverywhere(ctx.realUserId");
    expect(src).not.toContain("signOutEverywhere(ctx.userId");
  });

  test("the handoff hands over the REAL person, never the one being worn", () => {
    // Acting as Joel, `ctx.userId` IS Joel. A ticket minted for it would become
    // a full session as Joel on the destination, with no grant behind it — no
    // banner, no hour — which is exactly the takeover this block exists to stop.
    const src = readFileSync("app/auth/sso/authorize/route.ts", "utf8");
    expect(src).toContain("userId: ctx.realUserId");
    expect(src).not.toContain("userId: ctx.userId");
  });

  test("the act-as action decides from the REAL identity, never the worn one", () => {
    const src = readFileSync("app/act-as/actions.ts", "utf8");
    expect(src).toContain("realUserId: ctx.realUserId");
    expect(src).toContain("realIsStaff: ctx.realIsStaff");
    expect(src).not.toContain("realUserId: ctx.userId");
    expect(src).not.toContain("realIsStaff: ctx.scope.isStaff");
  });

  test("the banner is resolved by the shell, so no page can omit it", () => {
    const src = readFileSync("app/portal-shell.tsx", "utf8");
    expect(src).toContain("await getSessionContext()");
    expect(src).toContain("You are acting as");
    expect(src).toContain("stopActingAsAction");
  });
});
