import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { Client } from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Self-hosted sign-in (Better Auth, 0022), end to end through its real HTTP
 * handler against the real database, as each role that matters.
 *
 * Nothing here is mocked except the mailbox: emailed codes are captured
 * instead of sent. Sessions, the authenticator gate, the clocks and the
 * portal's view of a session are all the production code paths.
 */

const env = vi.hoisted(() => {
  process.env.PRIMARY_HOST = "login.portal-a.test:3000";
  process.env.PORTAL_HOST = "app.portal-a.test:3001";
  process.env.SESSION_COOKIE_SECURE = "false";
  process.env.BETTER_AUTH_SECRET ??= "test-only-better-auth-secret-0123456789abcdef";
  return { origin: "http://login.portal-a.test:3000" };
});

const mailbox = vi.hoisted(() => [] as { to: string; code: string; purpose: string }[]);
vi.mock("@/lib/auth/mailer", () => ({
  sendAuthCode: async (m: { to: string; code: string; purpose: string }) => {
    mailbox.push({ to: m.to, code: m.code, purpose: m.purpose });
  },
}));

const { getAuth } = await import("@/lib/auth/auth");
const { authenticatorState, resolveAccount, safeNext } = await import("@/lib/auth/login");
const { closeAuthPool, assertAuthRole } = await import("@/lib/db/auth-connection");
const { closePool } = await import("@/lib/db/connection");
const { inviteToOrganization } = await import("@/lib/db/invitations");
const { mintTicket, redeemTicket, consumeTicketsForAuthSession } = await import("@/lib/db/identity");
const { userByAuthUserId } = await import("@/lib/db/accounts");
const { hashTicket } = await import("@/lib/auth/sso");

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const app = new Client({ connectionString: process.env.DATABASE_APP_URL });

const TAG = `ba${Date.now().toString(36)}`;
const PASSWORD = "correct horse battery staple";
const made = { users: [] as string[], orgs: [] as string[] };
let orgId = "";
let inviterId = "";
let ipCounter = 0;

const operator = (...args: string[]) =>
  promisify(execFile)("node", ["scripts/identity-bindings.mjs", ...args, "--operator", "Test Operator"], {
    env: process.env,
  });

const address = (label: string) => `${label}-${TAG}@test.invalid`;

/* ------------------------------------------------------------------ */
/* A browser: a cookie jar, the login host's Origin, its own address   */
/* ------------------------------------------------------------------ */

class Browser {
  jar = new Map<string, string>();
  ip = `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
  origin = env.origin;

  async call(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const headers = new Headers({
      origin: this.origin,
      "x-real-ip": this.ip,
      cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await getAuth().handler(
      new Request(`${env.origin}/api/auth${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      const expired = attrs.some((a) => /max-age=0/i.test(a)) || value === "";
      if (expired) this.jar.delete(name!.trim());
      else this.jar.set(name!.trim(), value);
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, json: json as Record<string, unknown> };
  }

  async session() {
    const r = await this.call("/get-session");
    return r.json as { session: Record<string, unknown>; user: Record<string, unknown> } | null;
  }
}

function lastCode(to: string, purpose: string): string {
  const hit = [...mailbox].reverse().find((m) => m.to === to && m.purpose === purpose);
  if (!hit) throw new Error(`no ${purpose} code for ${to}`);
  return hit.code;
}

/* An independent RFC 6238 implementation, so the test does not grade the
   server's TOTP with the server's own code. Reads the secret from the
   otpauth:// address an authenticator app would scan. */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of input.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(uri: string, at = Date.now()): string {
  const secret = base32Decode(new URL(uri).searchParams.get("secret")!);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return bin.toString().padStart(6, "0");
}

/** Invited, signed up, address confirmed, signed in with the password. Not past the authenticator. */
async function invitedAndSignedIn(label: string, role: "owner" | "member" = "member") {
  const email = address(label);
  await inviteToOrganization({ organizationId: orgId, email, role, invitedBy: inviterId });
  const b = new Browser();
  const up = await b.call("/sign-up/email", { email, password: PASSWORD, name: label });
  expect(up.status).toBe(200);
  const verified = await b.call("/email-otp/verify-email", {
    email,
    otp: lastCode(email, "email-verification"),
  });
  expect(verified.status).toBe(200);
  const signedIn = await b.call("/sign-in/email", { email, password: PASSWORD });
  expect(signedIn.status).toBe(200);
  return { b, email };
}

/** Set up and confirm an authenticator for a signed-in browser; returns its otpauth URI. */
async function enroll(b: Browser) {
  const started = await b.call("/mfa/start-enrollment", {});
  expect(started.status).toBe(200);
  const uri = started.json.totpURI as string;
  const used = totp(uri);
  const confirmed = await b.call("/mfa/confirm-enrollment", { code: used });
  expect(confirmed.status).toBe(200);
  return { uri, used, recoveryCodes: confirmed.json.recoveryCodes as string[] };
}

async function authUserId(email: string): Promise<string | null> {
  const { rows } = await owner.query("select id from auth_users where email = $1", [email]);
  return rows[0]?.id ?? null;
}

beforeAll(async () => {
  await owner.connect();
  await app.connect();
  const org = await owner.query(
    "insert into organizations (type, name, slug) values ('client', $1, $1) returning id",
    [`org-${TAG}`],
  );
  orgId = org.rows[0].id;
  made.orgs.push(orgId);
  const inviter = await owner.query("insert into users (email) values ($1) returning id", [address("inviter")]);
  inviterId = inviter.rows[0].id;
  made.users.push(inviterId);
});

beforeEach(async () => {
  // Rate-limit counters are per address and per minute; each test is a fresh start.
  await owner.query("delete from auth_rate_limits");
});

afterAll(async () => {
  await owner.query("delete from auth_users where email like $1", [`%-${TAG}@test.invalid`]);
  const users = await owner.query("select id from users where email like $1", [`%-${TAG}@test.invalid`]);
  const ids = users.rows.map((r) => r.id);
  await owner.query("delete from sso_tickets where user_id = any($1::uuid[])", [ids]);
  await owner.query("delete from sessions where user_id = any($1::uuid[])", [ids]);
  await owner.query("delete from identity_bindings where user_id = any($1::uuid[])", [ids]);
  await owner.query("delete from memberships where user_id = any($1::uuid[])", [ids]);
  await owner.query("delete from invitations where organization_id = $1", [orgId]);
  await owner.query("delete from user_emails where user_id = any($1::uuid[])", [ids]);
  await owner.query("delete from users where id = any($1::uuid[])", [ids]);
  await owner.query("delete from organizations where id = any($1::uuid[])", [made.orgs]);
  await owner.end();
  await app.end();
  await closeAuthPool();
  await closePool();
});

/* ------------------------------------------------------------------ */

describe("the sign-in role", () => {
  test("is restricted: no superuser, no BYPASSRLS, owns nothing, cannot read portal tables", async () => {
    await expect(assertAuthRole()).resolves.toBeUndefined();
  });

  test("the portal's role cannot read any sign-in table", async () => {
    for (const table of ["auth_users", "auth_sessions", "auth_accounts", "auth_two_factors", "auth_verifications"]) {
      await expect(app.query(`select 1 from ${table} limit 1`)).rejects.toThrow(/permission denied/);
    }
  });
});

describe("only invited addresses get an identity", () => {
  test("signing up an address nobody invited creates nothing and sends nothing", async () => {
    const email = address("stranger");
    const b = new Browser();
    await b.call("/sign-up/email", { email, password: PASSWORD, name: "Stranger" });
    // The answer is deliberately the same as for an invited address.
    expect(await authUserId(email)).toBeNull();
    expect(mailbox.some((m) => m.to === email)).toBe(false);
  });

  test("an emailed sign-in code for an uninvited address is not sent, and cannot create one", async () => {
    const email = address("stranger2");
    const b = new Browser();
    const sent = await b.call("/email-otp/send-verification-otp", { email, type: "sign-in" });
    expect(sent.status).toBe(200); // the same answer as for anybody
    expect(mailbox.some((m) => m.to === email)).toBe(false);
    const guess = await b.call("/sign-in/email-otp", { email, otp: "123456" });
    expect(guess.status).toBeGreaterThanOrEqual(400);
    expect(await authUserId(email)).toBeNull();
  });

  test("an invited address can sign up, but cannot sign in until it is confirmed", async () => {
    const email = address("unconfirmed");
    await inviteToOrganization({ organizationId: orgId, email, role: "member", invitedBy: inviterId });
    const b = new Browser();
    expect((await b.call("/sign-up/email", { email, password: PASSWORD, name: "U" })).status).toBe(200);
    const early = await b.call("/sign-in/email", { email, password: PASSWORD });
    expect(early.status).toBe(403);
    expect(early.json.code).toBe("EMAIL_NOT_VERIFIED");
    expect(await b.session()).toBeNull();
  });
});

describe("the authenticator is required after every way of signing in", () => {
  test("password: signed in, but every endpoint except finishing sign-in answers 403", async () => {
    const { b } = await invitedAndSignedIn("gate-password");
    const s = await b.session();
    expect(s?.session.mfaVerifiedAt ?? null).toBeNull();
    const blocked = await b.call("/list-sessions");
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe("MFA_REQUIRED");
    expect((await b.call("/list-accounts")).status).toBe(403);
    expect((await b.call("/revoke-other-sessions", {})).status).toBe(403);
  });

  test("emailed code: the same gate", async () => {
    const { email } = await invitedAndSignedIn("gate-otp");
    const b = new Browser();
    await b.call("/email-otp/send-verification-otp", { email, type: "sign-in" });
    const r = await b.call("/sign-in/email-otp", { email, otp: lastCode(email, "sign-in") });
    expect(r.status).toBe(200);
    expect((await b.session())?.session.mfaVerifiedAt ?? null).toBeNull();
    expect((await b.call("/list-sessions")).status).toBe(403);
  });

  test("any other way a session is made (Google, Microsoft): born unverified, whatever the caller says", async () => {
    const { email } = await invitedAndSignedIn("gate-social");
    const id = (await authUserId(email))!;
    const ctx = await getAuth().$context;
    // What the social callback does, with a hostile override on top.
    const session = await ctx.internalAdapter.createSession(id, false, {
      mfaVerifiedAt: new Date(),
    } as never);
    const { rows } = await owner.query("select mfa_verified_at from auth_sessions where id = $1", [session.id]);
    expect(rows[0].mfa_verified_at).toBeNull();
  });

  test("the bypasses are switched off: two-factor plugin endpoints, editing the session", async () => {
    const { b } = await invitedAndSignedIn("gate-bypass");
    for (const path of ["/two-factor/enable", "/two-factor/verify-totp", "/two-factor/disable", "/update-session"]) {
      const r = await b.call(path, { code: "000000", password: PASSWORD, mfaVerifiedAt: new Date() });
      expect(r.status, path).toBe(404);
    }
    expect((await b.session())?.session.mfaVerifiedAt ?? null).toBeNull();
  });

  test("enrolment: confirmed only by a code from the app, recovery codes once, then the gate opens", async () => {
    const { b, email } = await invitedAndSignedIn("enrol");
    const started = await b.call("/mfa/start-enrollment", {});
    const uri = started.json.totpURI as string;
    expect(uri).toMatch(/^otpauth:\/\/totp\/10XiD(:|%3A)/);
    expect((await b.call("/mfa/confirm-enrollment", { code: "000000" })).status).toBe(401);
    expect((await b.call("/list-sessions")).status).toBe(403);

    const confirmed = await b.call("/mfa/confirm-enrollment", { code: totp(uri) });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.recoveryCodes).toHaveLength(10);
    expect((await b.session())?.session.mfaVerifiedAt).toBeTruthy();
    expect((await b.call("/list-sessions")).status).toBe(200);

    // A confirmed authenticator cannot be replaced by starting again.
    expect((await b.call("/mfa/start-enrollment", {})).json.code).toBe("MFA_ALREADY_ENROLLED");
    const state = await authenticatorState((await authUserId(email))!);
    expect(state).toEqual({ state: "enrolled", recoveryCodesLeft: 10 });
  });

  test("a code is accepted once per 30-second step; ten failures lock the factor", async () => {
    const { b, email } = await invitedAndSignedIn("replay");
    const { uri, used } = await enroll(b);

    // A second browser signs in; the code just used to enrol is refused.
    const b2 = new Browser();
    await b2.call("/sign-in/email", { email, password: PASSWORD });
    expect((await b2.call("/mfa/verify", { code: used })).status).toBe(401);
    // The next step's code (inside the window) works, once.
    const next = totp(uri, Date.now() + 30_000);
    expect((await b2.call("/mfa/verify", { code: next })).status).toBe(200);
    const b3 = new Browser();
    await b3.call("/sign-in/email", { email, password: PASSWORD });
    expect((await b3.call("/mfa/verify", { code: next })).status).toBe(401);

    for (let i = 0; i < 10; i++) {
      await owner.query("delete from auth_rate_limits");
      await b3.call("/mfa/verify", { code: "000000" });
    }
    const locked = await b3.call("/mfa/verify", { code: totp(uri, Date.now() + 60_000) });
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe("MFA_LOCKED");
  });

  test("recovery codes: each works once, in place of the authenticator", async () => {
    const { b, email } = await invitedAndSignedIn("recovery");
    const { recoveryCodes } = await enroll(b);
    const b2 = new Browser();
    await b2.call("/sign-in/email", { email, password: PASSWORD });
    const used = await b2.call("/mfa/recover", { code: recoveryCodes[0] });
    expect(used.status).toBe(200);
    expect(used.json.remaining).toBe(9);
    expect((await b2.call("/list-sessions")).status).toBe(200);

    const b3 = new Browser();
    await b3.call("/sign-in/email", { email, password: PASSWORD });
    expect((await b3.call("/mfa/recover", { code: recoveryCodes[0] })).status).toBe(401);
    expect((await b3.call("/list-sessions")).status).toBe(403);
  });

  test("replacing the authenticator needs it recently, and closes the gate again", async () => {
    const { b } = await invitedAndSignedIn("reset-factor");
    await enroll(b);
    const s = (await b.session())!;
    await owner.query(
      "update auth_sessions set mfa_verified_at = now() - interval '11 minutes' where id = $1",
      [s.session.id],
    );
    expect((await b.call("/mfa/reset-authenticator", {})).json.code).toBe("MFA_NOT_FRESH");
    expect((await b.call("/mfa/regenerate-recovery-codes", {})).json.code).toBe("MFA_NOT_FRESH");
    await owner.query("update auth_sessions set mfa_verified_at = now() where id = $1", [s.session.id]);
    expect((await b.call("/mfa/regenerate-recovery-codes", {})).json.recoveryCodes).toHaveLength(10);
    expect((await b.call("/mfa/reset-authenticator", {})).status).toBe(200);
    expect((await b.call("/list-sessions")).status).toBe(403);
    expect((await b.call("/mfa/start-enrollment", {})).status).toBe(200);
  });
});

describe("proving an address wipes what came before it", () => {
  test("someone else's password, provider link and authenticator do not survive the owner's first emailed code", async () => {
    const email = address("prehijack");
    await inviteToOrganization({ organizationId: orgId, email, role: "member", invitedBy: inviterId });
    const attacker = new Browser();
    await attacker.call("/sign-up/email", { email, password: "attacker-chosen-password", name: "Mallory" });
    const id = (await authUserId(email))!;
    await owner.query(
      `insert into auth_two_factors (id, user_id, secret, backup_codes, verified) values ($1, $2, 'x', 'x', true)`,
      [randomUUID(), id],
    );
    await owner.query(
      `insert into auth_accounts (id, user_id, account_id, provider_id, created_at, updated_at)
       values ($1, $2, 'mallory-ms', 'microsoft', now(), now())`,
      [randomUUID(), id],
    );

    const victim = new Browser();
    await victim.call("/email-otp/send-verification-otp", { email, type: "sign-in" });
    expect((await victim.call("/sign-in/email-otp", { email, otp: lastCode(email, "sign-in") })).status).toBe(200);

    const left = await owner.query(
      `select (select count(*) from auth_two_factors where user_id = $1)::int as factors,
              (select count(*) from auth_accounts where user_id = $1)::int as accounts`,
      [id],
    );
    expect(left.rows[0]).toEqual({ factors: 0, accounts: 0 });
    expect((await attacker.call("/sign-in/email", { email, password: "attacker-chosen-password" })).status).toBe(401);
  });
});

describe("signing in grants nothing by itself", () => {
  test("an invitation to exactly this verified address is accepted only after the authenticator", async () => {
    const { b, email } = await invitedAndSignedIn("invited", "owner");
    const id = (await authUserId(email))!;
    expect(await userByAuthUserId(id)).toBeNull();
    await enroll(b);
    const s = (await b.session())!;
    const outcome = await resolveAccount({ id, email, emailVerified: true, name: "x" });
    expect(outcome).toBe("invitation_accepted");
    const account = await userByAuthUserId(id);
    expect(account?.email).toBe(email);
    const m = await owner.query("select organization_id, role from memberships where user_id = $1", [account!.id]);
    expect(m.rows).toEqual([{ organization_id: orgId, role: "owner" }]);
    expect(s.session.mfaVerifiedAt).toBeTruthy();
    // The second time, it is already bound.
    expect(await resolveAccount({ id, email, emailVerified: true, name: "x" })).toBe("bound");
  });

  test("an existing account with the same address is NOT merged: an operator confirms", async () => {
    const email = address("existing");
    const existing = await owner.query("insert into users (email) values ($1) returning id", [email]);
    const b = new Browser();
    await b.call("/email-otp/send-verification-otp", { email, type: "sign-in" });
    await b.call("/sign-in/email-otp", { email, otp: lastCode(email, "sign-in") });
    await enroll(b);
    const id = (await authUserId(email))!;
    expect(await resolveAccount({ id, email, emailVerified: true, name: "x" })).toBe("binding_requested");
    expect(await userByAuthUserId(id)).toBeNull();
    const row = await owner.query("select auth_user_id from users where id = $1", [existing.rows[0].id]);
    expect(row.rows[0].auth_user_id).toBeNull();
    const req = await owner.query("select auth_user_id, decision from identity_bindings where user_id = $1", [
      existing.rows[0].id,
    ]);
    expect(req.rows).toEqual([{ auth_user_id: id, decision: null }]);
    // And the application role cannot bind it itself.
    await expect(
      app.query("update users set auth_user_id = $2 where id = $1", [existing.rows[0].id, id]),
    ).rejects.toThrow(/Only an operator binds/);
  });

  test("an operator's confirmation binds it; then it resolves, and only then", async () => {
    const email = address("confirmed");
    await owner.query("insert into users (email) values ($1)", [email]);
    const b = new Browser();
    await b.call("/email-otp/send-verification-otp", { email, type: "sign-in" });
    await b.call("/sign-in/email-otp", { email, otp: lastCode(email, "sign-in") });
    await enroll(b);
    const id = (await authUserId(email))!;
    expect(await resolveAccount({ id, email, emailVerified: true, name: "x" })).toBe("binding_requested");
    const req = await owner.query("select id from identity_bindings where auth_user_id = $1", [id]);
    await operator("confirm", req.rows[0].id);
    expect((await userByAuthUserId(id))?.email).toBe(email);
    expect(await resolveAccount({ id, email, emailVerified: true, name: "x" })).toBe("bound");
  });

  test("an unverified identity resolves to nothing", async () => {
    expect(
      await resolveAccount({ id: `nobody-${TAG}`, email: address("unverified"), emailVerified: false, name: "" }),
    ).toBe("unverified");
  });
});

describe("session clocks, enforced by the database", () => {
  async function liveSession(label: string) {
    const { b } = await invitedAndSignedIn(label);
    await enroll(b);
    return { b, id: (await b.session())!.session.id as string };
  }
  /** Rewrite a session's clocks as an operator would, past the triggers. */
  async function backdate(id: string, set: string) {
    await owner.query("begin");
    await owner.query("set local session_replication_role = replica");
    await owner.query(`update auth_sessions set ${set} where id = $1`, [id]);
    await owner.query("commit");
  }
  const touch = async (id: string) =>
    (await app.query("select auth_session_touch($1) as hard_end", [id])).rows[0].hard_end as Date | null;

  test("48 hours idle: signed out, and the portal is told so", async () => {
    const { b, id } = await liveSession("idle");
    expect(await touch(id)).toBeInstanceOf(Date);
    await backdate(id, "last_active_at = now() - interval '48 hours 1 minute'");
    expect(await b.session()).toBeNull();
    expect(await touch(id)).toBeNull();
  });

  test("seven days from sign-in is the end, whatever the expiry column says", async () => {
    const { b, id } = await liveSession("hard-end");
    await backdate(id, "created_at = now() - interval '7 days 1 minute', expires_at = now() + interval '7 days'");
    expect(await b.session()).toBeNull();
    expect(await touch(id)).toBeNull();
  });

  test("activity never extends the seven days", async () => {
    const { b, id } = await liveSession("no-extend");
    await backdate(id, "created_at = now() - interval '6 days 23 hours', updated_at = now() - interval '2 days'");
    // A refresh: Better Auth writes a new expiry seven days out.
    await owner.query("update auth_sessions set expires_at = now() + interval '7 days' where id = $1", [id]);
    const { rows } = await owner.query(
      "select expires_at <= created_at + interval '7 days' as capped, last_active_at > now() - interval '1 minute' as active from auth_sessions where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ capped: true, active: true });
    const hardEnd = await touch(id);
    expect(hardEnd!.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 1000);
    expect(await b.session()).not.toBeNull();
  });

  test("a session row cannot be re-pointed or re-dated", async () => {
    const { id } = await liveSession("immutable");
    await owner.query(
      "update auth_sessions set created_at = now() + interval '1 day', user_id = user_id, token = 'stolen' where id = $1",
      [id],
    );
    const { rows } = await owner.query("select created_at <= now() as same, token <> 'stolen' as kept from auth_sessions where id = $1", [id]);
    expect(rows[0]).toEqual({ same: true, kept: true });
  });

  test("the portal cannot touch a session that has not passed the authenticator", async () => {
    const { b } = await invitedAndSignedIn("touch-unverified");
    expect(await touch((await b.session())!.session.id as string)).toBeNull();
  });
});

describe("revocation and signing out", () => {
  test("an operator can reset a lost authenticator: sessions end, the next sign-in enrols afresh", async () => {
    const { b, email } = await invitedAndSignedIn("operator-reset");
    await enroll(b);
    await operator("reset-authenticator", email);
    expect(await b.session()).toBeNull();
    const b2 = new Browser();
    await b2.call("/sign-in/email", { email, password: PASSWORD });
    expect((await b2.call("/list-sessions")).status).toBe(403);
    expect(await authenticatorState((await authUserId(email))!)).toEqual({ state: "none" });
  });

  test("signing out everywhere ends every sign-in session, and the portal sees it", async () => {
    const { b, email } = await invitedAndSignedIn("everywhere");
    const { uri } = await enroll(b);
    const b2 = new Browser();
    await b2.call("/sign-in/email", { email, password: PASSWORD });
    await b2.call("/mfa/verify", { code: totp(uri, Date.now() + 30_000) });
    const ids = [(await b.session())!.session.id as string, (await b2.session())!.session.id as string];
    expect((await b.call("/revoke-sessions", {})).status).toBe(200);
    expect(await b2.session()).toBeNull();
    for (const id of ids) {
      expect((await app.query("select auth_session_touch($1) as t", [id])).rows[0].t).toBeNull();
    }
  });

  test("the portal can end one sign-in session, and nothing else", async () => {
    const { b } = await invitedAndSignedIn("portal-revoke");
    await enroll(b);
    const id = (await b.session())!.session.id as string;
    await app.query("select auth_revoke_session($1)", [id]);
    expect(await b.session()).toBeNull();
    await expect(app.query("delete from auth_sessions")).rejects.toThrow(/permission denied/);
  });

  test("a password reset signs out every session", async () => {
    const { b, email } = await invitedAndSignedIn("reset");
    await enroll(b);
    const r = new Browser();
    await r.call("/email-otp/request-password-reset", { email });
    const reset = await r.call("/email-otp/reset-password", {
      email,
      otp: lastCode(email, "forget-password"),
      password: "an entirely new passphrase",
    });
    expect(reset.status).toBe(200);
    expect(await b.session()).toBeNull();
  });
});

describe("requests from anywhere but the login host", () => {
  test("a cross-site POST is refused (login CSRF)", async () => {
    const { email } = await invitedAndSignedIn("csrf");
    const evil = new Browser();
    evil.origin = "https://evil.test";
    const r = await evil.call("/sign-in/email", { email, password: PASSWORD });
    expect(r.status).toBe(403);
    expect(evil.jar.size).toBe(0);
  });

  test("the portal host is not a trusted origin either", async () => {
    const { email } = await invitedAndSignedIn("csrf-portal");
    const portal = new Browser();
    portal.origin = "http://app.portal-a.test:3001";
    expect((await portal.call("/sign-in/email", { email, password: PASSWORD })).status).toBe(403);
  });

  test("the session cookie is host-only: no Domain attribute", async () => {
    const { email } = await invitedAndSignedIn("hostonly");
    const response = await getAuth().handler(
      new Request(`${env.origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: env.origin, "content-type": "application/json", "x-real-ip": "10.99.0.1" },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("10xid.session_token="))).toBe(true);
    for (const c of cookies) {
      expect(c).not.toMatch(/domain=/i);
      expect(c).toMatch(/httponly/i);
    }
  });
});

describe("the handoff ticket", () => {
  test("names its sign-in session, works once, and dies with that session's sign-out", async () => {
    const { b, email } = await invitedAndSignedIn("ticket");
    await enroll(b);
    const id = (await authUserId(email))!;
    await resolveAccount({ id, email, emailVerified: true, name: "x" });
    const account = (await userByAuthUserId(id))!;
    const authSessionId = (await b.session())!.session.id as string;
    const mint = (token: string) =>
      mintTicket({
        ticketHash: hashTicket(token),
        userId: account.id,
        audienceHost: "app.portal-a.test:3001",
        returnPath: "/",
        sourceAuthSessionId: authSessionId,
        expiresAt: new Date(Date.now() + 30_000),
      });

    await mint("ticket-one");
    expect(await redeemTicket(hashTicket("ticket-one"), "northstar.test")).toBeNull();
    const redeemed = await redeemTicket(hashTicket("ticket-one"), "app.portal-a.test:3001");
    expect(redeemed).toMatchObject({ userId: account.id, sourceAuthSessionId: authSessionId });
    expect(await redeemTicket(hashTicket("ticket-one"), "app.portal-a.test:3001")).toBeNull();

    await mint("ticket-two");
    await consumeTicketsForAuthSession(authSessionId);
    expect(await redeemTicket(hashTicket("ticket-two"), "app.portal-a.test:3001")).toBeNull();
  });
});

describe("the handoff names the bound account", () => {
  test("the ticket's user is the account bound to the signed-in identity, never session-carried state", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/auth/sso/authorize/route.ts", "utf8");
    expect(src).toContain("userByAuthUserId(session.user.id)");
    expect(src).toContain("userId: account.id");
    expect(src).toContain("if (!session.mfaVerifiedAt)");
    expect(src).not.toContain("actingAs");
  });
});

describe("where sign-in may resume", () => {
  test("only the handoff or the account page; everything else is home", () => {
    expect(safeNext("/auth/sso/authorize?site=x&state=y")).toBe("/auth/sso/authorize?site=x&state=y");
    expect(safeNext("/auth/account")).toBe("/auth/account");
    for (const bad of ["//evil.test", "https://evil.test", "/\\evil.test", "/jobs", "/auth/sso/authorizeX", null, ""]) {
      expect(safeNext(bad)).toBe("/");
    }
  });
});
