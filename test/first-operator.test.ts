import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "pg";

/**
 * The first operator (lib/auth/operator.ts): confirming a binding needs an
 * operator, and an operator needs a bound account, so until one operator is
 * bound a listed address may confirm its OWN open request — and nothing else,
 * and nobody else. Real database; only the sign-in session is stood in for.
 */

const signedIn = vi.hoisted(() => ({
  current: null as null | {
    sessionId: string;
    token: string;
    mfaVerifiedAt: Date | null;
    createdAt: Date;
    user: { id: string; email: string; emailVerified: boolean; name: string };
  },
}));
vi.mock("@/lib/auth/login", () => ({
  getLoginSession: async () => signedIn.current,
  assertLoginOrigin: async () => {},
}));
class Redirect extends Error {
  constructor(readonly to: string) {
    super(to);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new Redirect("404");
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getOperator } = await import("@/lib/auth/operator");
const actions = await import("@/app/auth/operator/actions");

async function act(fn: (f: FormData) => Promise<unknown>, fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  try {
    await fn(f);
    return "returned";
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    throw e;
  }
}

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const TAG = `fo${Date.now().toString(36)}`;
const addr = (l: string) => `${l}-${TAG}@test.invalid`;
const OPERATOR = addr("paolo");
const OTHER_OPERATOR = addr("second-op");

/** An account from before, and an open request to bind `authUserId` (signed in as `email`) to it. */
async function pending(label: string, email = addr(label)) {
  const userId = (await owner.query("insert into users (email) values ($1) returning id", [addr(label)])).rows[0]
    .id as string;
  const authUserId = `auth-${label}-${TAG}`;
  const requestId = (
    await owner.query(
      "insert into identity_bindings (user_id, auth_user_id, email) values ($1, $2, $3) returning id",
      [userId, authUserId, email],
    )
  ).rows[0].id as string;
  return { userId, authUserId, requestId };
}

function signIn(authUserId: string, email: string, opts: { mfa?: boolean; verified?: boolean } = {}) {
  signedIn.current = {
    sessionId: `s-${authUserId}`,
    token: "t",
    mfaVerifiedAt: opts.mfa === false ? null : new Date(),
    createdAt: new Date(),
    user: { id: authUserId, email, emailVerified: opts.verified ?? true, name: email },
  };
}

beforeAll(async () => {
  await owner.connect();
});

beforeEach(() => {
  process.env.OPERATOR_EMAILS = `${OPERATOR}, ${OTHER_OPERATOR}`;
  signedIn.current = null;
});

afterAll(async () => {
  const like = `%-${TAG}@test.invalid`;
  await owner.query("delete from identity_bindings where email like $1", [like]);
  await owner.query("delete from user_emails where email like $1", [like]);
  await owner.query("delete from users where email like $1", [like]);
  await owner.end();
});

describe("before any operator is bound", () => {
  test("a listed address may confirm its own open request, and only that", async () => {
    const me = await pending("paolo");
    signIn(me.authUserId, OPERATOR);
    const op = await getOperator();
    expect(op).toMatchObject({ email: OPERATOR, bootstrapRequestId: me.requestId, accountId: me.userId });
  });

  test("not without the authenticator, or with an unproven address", async () => {
    const { authUserId } = (await owner.query(
      "select auth_user_id as \"authUserId\" from identity_bindings where email = $1",
      [OPERATOR],
    )).rows[0];
    signIn(authUserId, OPERATOR, { mfa: false });
    expect(await getOperator()).toBeNull();
    signIn(authUserId, OPERATOR, { verified: false });
    expect(await getOperator()).toBeNull();
  });

  test("not for an address that is not on the list", async () => {
    const stranger = await pending("stranger");
    signIn(stranger.authUserId, addr("stranger"));
    expect(await getOperator()).toBeNull();
  });

  test("not when the request is for a different address than the sign-in", async () => {
    // Signed in as the listed address, but the open request names another one.
    const mismatch = await pending("mismatch", addr("someone-else"));
    signIn(mismatch.authUserId, OTHER_OPERATOR);
    expect(await getOperator()).toBeNull();
  });

  test("not with no open request", async () => {
    signIn(`auth-nobody-${TAG}`, OPERATOR);
    expect(await getOperator()).toBeNull();
  });
});

describe("what the first operator may do", () => {
  test("not reject, not decide somebody else's request, not invite, not end anybody's access", async () => {
    const me = (await owner.query(
      "select id, auth_user_id as \"authUserId\" from identity_bindings where email = $1",
      [OPERATOR],
    )).rows[0];
    const stranger = (await owner.query("select id from identity_bindings where email = $1", [addr("stranger")])).rows[0];
    signIn(me.authUserId, OPERATOR);

    expect(await act(actions.decideBindingAction, { request: me.id, decision: "reject" })).toBe(
      "/auth/operator?error=first_operator",
    );
    expect(await act(actions.decideBindingAction, { request: stranger.id, decision: "confirm" })).toBe(
      "/auth/operator?error=first_operator",
    );
    expect(
      await act(actions.inviteAction, { email: addr("x"), business: "00000000-0000-4000-8000-000000000000", role: "viewer" }),
    ).toBe("/auth/operator?error=first_operator");
    expect(await act(actions.endAccessAction, { email: addr("stranger"), what: "sign-out" })).toBe(
      "/auth/operator?error=first_operator",
    );
    // Nothing was decided.
    const open = await owner.query("select count(*)::int as n from identity_bindings where email like $1 and decision is null", [
      `%-${TAG}@test.invalid`,
    ]);
    expect(open.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  test("confirming their own request binds their account, and the shortcut then shuts", async () => {
    const me = (await owner.query(
      "select id, user_id as \"userId\", auth_user_id as \"authUserId\" from identity_bindings where email = $1",
      [OPERATOR],
    )).rows[0];
    signIn(me.authUserId, OPERATOR);
    expect(await act(actions.decideBindingAction, { request: me.id, decision: "confirm" })).toBe(
      "/auth/operator?notice=confirmed",
    );
    const bound = await owner.query("select auth_user_id from users where id = $1", [me.userId]);
    expect(bound.rows[0].auth_user_id).toBe(me.authUserId);
    // Now an ordinary operator.
    expect(await getOperator()).toMatchObject({ bootstrapRequestId: null, accountId: me.userId });
  });
});

describe("once an operator is bound, the shortcut is shut", () => {
  test("the bound operator is an ordinary operator; a second listed address gets nothing until confirmed", async () => {
    const { authUserId } = (await owner.query(
      "select auth_user_id as \"authUserId\" from identity_bindings where email = $1",
      [OPERATOR],
    )).rows[0];
    // Bound by the confirm action above.

    signIn(authUserId, OPERATOR);
    expect(await getOperator()).toMatchObject({ email: OPERATOR, bootstrapRequestId: null });

    const second = await pending("second-op");
    signIn(second.authUserId, OTHER_OPERATOR);
    expect(await getOperator()).toBeNull();
  });

  test("a bound account whose address is not listed is not an operator", async () => {
    process.env.OPERATOR_EMAILS = OTHER_OPERATOR;
    const { authUserId } = (await owner.query("select auth_user_id as \"authUserId\" from users where email = $1", [
      OPERATOR,
    ])).rows[0];
    signIn(authUserId, OPERATOR);
    expect(await getOperator()).toBeNull();
  });
});
