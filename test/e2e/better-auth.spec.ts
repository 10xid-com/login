import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { openAccountMenu, seededIds, totpCode } from "./helpers";

/**
 * Self-hosted sign-in, end to end, in a real browser, across the two real
 * hosts: login.portal-a.test (this app, Better Auth) and app.portal-a.test
 * (10xid-com/app, the portal). Nothing is stubbed but the mailbox, which the
 * dev server writes to a file.
 *
 *   npx playwright test test/e2e/better-auth.spec.ts --project=chromium
 */

const LOGIN = `http://${process.env.E2E_PRIMARY_HOST ?? "login.portal-a.test:3000"}`;
const APP = `http://${process.env.E2E_APP_HOST ?? "app.portal-a.test:3001"}`;
const SINK = process.env.DEV_CODE_SINK ?? "/tmp/portal-signin-codes.log";
const TAG = `e2e${Date.now().toString(36)}`;
const PASSWORD = "a long and correct passphrase";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* CI supplies the environment */
}

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return (await db.query(text, params)).rows as T[];
  } finally {
    await db.end();
  }
}

async function codeFor(email: string, purpose: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const lines = (await readFile(SINK, "utf8").catch(() => "")).split("\n");
    const hit = lines.filter((l) => l.split("\t")[1] === email && l.split("\t")[3] === purpose).at(-1);
    if (hit) return hit.split("\t")[2]!;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no ${purpose} code for ${email}`);
}

async function codesSentTo(email: string): Promise<number> {
  const lines = (await readFile(SINK, "utf8").catch(() => "")).split("\n");
  return lines.filter((l) => l.split("\t")[1] === email).length;
}

let orgId = "";
async function invite(label: string): Promise<string> {
  const email = `${label}-${TAG}@test.invalid`;
  const [inviter] = await sql<{ id: string }>("select id from users order by created_at limit 1");
  await sql(
    `insert into invitations (email, organization_id, role, invited_by, expires_at)
     values ($1, $2, 'owner', $3, now() + interval '7 days')`,
    [email, orgId, inviter!.id],
  );
  return email;
}

/** The secret from the setup page's manual key, exactly as a person would type it into an app. */
async function enrolFromPage(page: Page): Promise<{ secret: string; used: string; recoveryCodes: string[] }> {
  await expect(page).toHaveURL(/\/auth\/mfa\/setup/);
  if (await page.getByRole("button", { name: "Begin" }).isVisible()) {
    await page.getByRole("button", { name: "Begin" }).click();
  }
  const secret = (await page.locator("p.font-mono").innerText()).replace(/\s+/g, "");
  const used = totpCode(secret);
  lastStep.set(secret, Math.floor(Date.now() / 30_000));
  await page.getByLabel("Code").fill(used);
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page).toHaveURL(/\/auth\/mfa\/recovery-codes/);
  const items = page.locator("ul li");
  await expect(items).toHaveCount(10);
  return { secret, used, recoveryCodes: await items.allInnerTexts() };
}

/**
 * A code the server will accept: the earliest 30-second step inside its
 * one-step window that is later than any step already used for this secret
 * (each step is accepted once, ever).
 */
const lastStep = new Map<string, number>();
async function freshCode(secret: string): Promise<string> {
  // Like a person waiting for the app to show the next code.
  for (;;) {
    const now = Math.floor(Date.now() / 30_000);
    const step = Math.max(now - 1, (lastStep.get(secret) ?? -Infinity) + 1);
    if (step <= now + 1) {
      lastStep.set(secret, step);
      return totpCode(secret, step * 30_000);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * The operator the login dev server was started with (OPERATOR_EMAILS). The
 * first run invites and binds them; later runs remove their authenticator so
 * the test can enrol a new one it knows.
 */
const OPERATOR = "operator-e2e@test.invalid";
let operatorSecretValue = "";
async function operatorSecret(): Promise<string> {
  return operatorSecretValue;
}
async function signInAsOperator(page: Page) {
  const bound = await sql("select 1 from users where email = $1 and auth_user_id is not null", [OPERATOR]);
  if (bound.length === 0) {
    await sql("delete from invitations where email = $1", [OPERATOR]);
    const [inviter] = await sql<{ id: string }>("select id from users order by created_at limit 1");
    await sql(
      `insert into invitations (email, organization_id, role, invited_by, expires_at)
       values ($1, $2, 'owner', $3, now() + interval '7 days')`,
      [OPERATOR, orgId, inviter!.id],
    );
  }
  await sql("delete from auth_two_factors where user_id = (select id from auth_users where email = $1)", [OPERATOR]);
  await page.goto(`${LOGIN}/auth/sign-in/code`);
  await page.getByLabel("Email").fill(OPERATOR);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill(await codeFor(OPERATOR, "sign-in"));
  await page.getByRole("button", { name: "Continue" }).click();
  operatorSecretValue = (await enrolFromPage(page)).secret;
  await page.getByRole("button", { name: /saved them/ }).click();
}

async function cookieNames(context: BrowserContext, origin: string) {
  return (await context.cookies(origin)).map((c) => c.name);
}

test.describe.configure({ mode: "serial" });

// Rate limits are per client address, and this whole suite is one address;
// each test starts from zero rather than the limits being raised for tests.
test.beforeEach(async () => {
  await sql("delete from auth_rate_limits");
});

test.beforeAll(async () => {
  const [org] = await sql<{ id: string }>(
    "insert into organizations (type, name, slug) values ('client', $1, $1) returning id",
    [`E2E ${TAG}`],
  );
  orgId = org!.id;
});

test("invited: emailed code → authenticator required → portal; then a password, which also needs the authenticator", async ({ page, context }) => {
  const email = await invite("owner");

  // A visit to the portal goes to the login host, by the handoff.
  await page.goto(`${APP}/dashboard`);
  await expect(page).toHaveURL(new RegExp(`^${LOGIN}/auth/sign-in\\?next=%2Fauth%2Fsso%2Fauthorize`));

  // Creating a sign-in is proving the mailbox: an emailed code.
  await page.getByRole("link", { name: "Create your sign-in" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill(await codeFor(email, "sign-in"));
  await page.getByRole("button", { name: "Continue" }).click();

  // Signed in — and stopped at the authenticator.
  const { secret } = await enrolFromPage(page);
  await page.getByRole("button", { name: /saved them/ }).click();

  // The invitation is accepted, the ticket minted and spent: on the portal.
  await expect(page).toHaveURL(`${APP}/dashboard`);

  // Each host has its own host-only cookie; neither sees the other's.
  expect(await cookieNames(context, LOGIN)).toContain("10xid.session_token");
  expect(await cookieNames(context, LOGIN)).not.toContain("portal_session");
  expect(await cookieNames(context, APP)).toContain("portal_session");
  expect(await cookieNames(context, APP)).not.toContain("10xid.session_token");
  for (const c of await context.cookies()) expect(c.domain.startsWith("."), c.name).toBe(false);

  const [bound] = await sql<{ auth_user_id: string | null; role: string }>(
    `select u.auth_user_id, m.role from users u join memberships m on m.user_id = u.id
      where u.email = $1 and m.organization_id = $2`,
    [email, orgId],
  );
  expect(bound?.auth_user_id).toBeTruthy();
  expect(bound?.role).toBe("owner");

  // Tenant isolation: another business's job is not found, not refused.
  const { northstar_job } = await seededIds();
  const response = await page.goto(`${APP}/jobs/${northstar_job}`);
  expect(response?.status()).toBe(404);

  // Sign out of the portal ends the sign-in on the login host too.
  await page.goto(`${APP}/dashboard`);
  await openAccountMenu(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in\?notice=signed-out/);
  await page.goto(`${APP}/dashboard`);
  await expect(page).toHaveURL(new RegExp(`^${LOGIN}/auth/sign-in`));

  // Add a password: only from a signed-in session past the authenticator.
  await page.goto(`${LOGIN}/auth/sign-in/code`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill(await codeFor(email, "sign-in"));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Code").fill(await freshCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.goto(`${LOGIN}/auth/account`);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Add password" }).click();
  await expect(page).toHaveURL(/notice=password/);
  await page.getByRole("button", { name: "Sign out", exact: true }).last().click();

  // Password sign-in: still the authenticator before the portal.
  await page.goto(`${APP}/dashboard`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/auth\/mfa\?/);
  await page.getByLabel("Code").fill(await freshCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(`${APP}/dashboard`);
});

test("emailed code: still the authenticator, and a used code is not accepted twice", async ({ page }) => {
  const email = await invite("coder");

  await page.goto(`${LOGIN}/auth/sign-in/code`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill(await codeFor(email, "sign-in"));
  await page.getByRole("button", { name: "Continue" }).click();
  const { secret, used } = await enrolFromPage(page);
  await page.getByRole("button", { name: /saved them/ }).click();

  // Sign out, sign in again with a code: the same 30-second authenticator
  // code that just confirmed enrolment is refused.
  await page.goto(`${LOGIN}/auth/account`);
  await page.getByRole("button", { name: "Sign out", exact: true }).last().click();
  await page.goto(`${LOGIN}/auth/sign-in/code`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill(await codeFor(email, "sign-in"));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/auth\/mfa(\?|$)/);
  await page.getByLabel("Code").fill(used);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("alert")).toContainText("not right");
  await page.getByLabel("Code").fill(await freshCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(new RegExp(`^${APP}/`));
});

test("an address nobody invited gets nothing — not even an email", async ({ page }) => {
  const email = `stranger-${TAG}@test.invalid`;
  await page.goto(`${LOGIN}/auth/sign-up`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  // The same screen an invited address sees.
  await expect(page).toHaveURL(/\/auth\/sign-in\/code\?email=/);
  await page.waitForTimeout(500);
  expect(await codesSentTo(email)).toBe(0);
  expect(await sql("select 1 from auth_users where email = $1", [email])).toHaveLength(0);
});

test("an existing account is not merged by address: it waits for an operator", async ({ page, browser }) => {
  const email = `legacy-${TAG}@test.invalid`;
  const [user] = await sql<{ id: string }>("insert into users (email) values ($1) returning id", [email]);
  await sql("insert into memberships (user_id, organization_id, role) values ($1, $2, 'owner')", [user!.id, orgId]);

  await page.goto(`${APP}/dashboard`);
  await page.getByRole("link", { name: "Email me a code instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill(await codeFor(email, "sign-in"));
  await page.getByRole("button", { name: "Continue" }).click();
  await enrolFromPage(page);
  await page.getByRole("button", { name: /saved them/ }).click();

  // Signed in, past the authenticator — and no access.
  await expect(page).toHaveURL(/\/auth\/access/);
  await expect(page.getByRole("heading")).toContainText("Waiting for confirmation");
  await page.goto(`${APP}/dashboard`);
  await expect(page).toHaveURL(/\/auth\/access/);

  // Not an operator: the operator screen does not exist for this person.
  const notOperator = await page.goto(`${LOGIN}/auth/operator`);
  expect(notOperator?.status()).toBe(404);
  await page.goto(`${LOGIN}/auth/access`);

  // An operator (OPERATOR_EMAILS on the login server) confirms it on the
  // operator screen, in their own browser.
  const operator = await browser.newContext();
  const op = await operator.newPage();
  await signInAsOperator(op);
  await op.goto(`${LOGIN}/auth/operator`);
  const row = op.getByRole("listitem").filter({ hasText: email });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Confirm" }).click();
  await expect(op.getByRole("status")).toContainText("Confirmed");
  const [decided] = await sql<{ decided_by: string }>(
    "select decided_by from identity_bindings where user_id = $1",
    [user!.id],
  );
  expect(decided?.decided_by).toBeTruthy();
  await operator.close();

  // "Check again" now goes straight through.
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page).toHaveURL(new RegExp(`^${APP}/dashboard`));
});

test("48 hours idle on the login host ends the portal session on its next request", async ({ page }) => {
  const email = await invite("idle");
  await page.goto(`${LOGIN}/auth/sign-in/code`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill(await codeFor(email, "sign-in"));
  await page.getByRole("button", { name: "Continue" }).click();
  await enrolFromPage(page);
  await page.goto(`${APP}/dashboard`);
  await expect(page).toHaveURL(`${APP}/dashboard`);

  await sql(
    `begin; set local session_replication_role = replica;
     update auth_sessions set last_active_at = now() - interval '49 hours'
      where user_id = (select id from auth_users where email = '${email}'); commit;`,
  );
  await page.goto(`${APP}/dashboard`);
  await expect(page).toHaveURL(new RegExp(`^${LOGIN}/auth/sign-in`));
  const [row] = await sql<{ revoked: boolean }>(
    `select revoked_at is not null as revoked from sessions
      where user_id = (select id from users where email = $1) order by created_at desc limit 1`,
    [email],
  );
  expect(row?.revoked).toBe(true);
});

test("a ticket works once: replaying the callback fails", async ({ page, context }) => {
  const email = await invite("replay");
  let callback = "";
  page.on("request", (r) => {
    if (r.url().includes("/auth/sso/callback")) callback = r.url();
  });
  await page.goto(`${APP}/dashboard`);
  await page.getByRole("link", { name: "Email me a code instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill(await codeFor(email, "sign-in"));
  await page.getByRole("button", { name: "Continue" }).click();
  await enrolFromPage(page);
  await page.getByRole("button", { name: /saved them/ }).click();
  await expect(page).toHaveURL(`${APP}/dashboard`);
  expect(callback).toContain("ticket=");

  // A second browser with the stolen callback URL, and this browser again.
  const other = await context.browser()!.newContext();
  const thief = await other.newPage();
  await thief.goto(callback);
  await expect(thief).toHaveURL(`${APP}/auth/sso/failed`);
  await other.close();
  await page.goto(callback);
  await expect(page).toHaveURL(`${APP}/auth/sso/failed`);
});

test("a recovery code stands in for a lost phone; signing out everywhere ends the portal too", async ({ page, browser }) => {
  const email = await invite("recover");
  await page.goto(`${LOGIN}/auth/sign-in/code`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill(await codeFor(email, "sign-in"));
  await page.getByRole("button", { name: "Continue" }).click();
  const { recoveryCodes } = await enrolFromPage(page);
  await page.goto(`${APP}/dashboard`);
  await expect(page).toHaveURL(`${APP}/dashboard`);

  // A second device, with only a recovery code.
  const second = await browser.newContext();
  const phoneless = await second.newPage();
  await phoneless.goto(`${LOGIN}/auth/sign-in/code`);
  await phoneless.getByLabel("Email").fill(email);
  await phoneless.getByRole("button", { name: "Email me a code" }).click();
  await phoneless.getByLabel("Code").fill(await codeFor(email, "sign-in"));
  await phoneless.getByRole("button", { name: "Continue" }).click();
  await phoneless.getByRole("link", { name: "Use a recovery code" }).click();
  await phoneless.getByLabel("Recovery code").fill(recoveryCodes[0]!);
  await phoneless.getByRole("button", { name: "Continue" }).click();
  await expect(phoneless).toHaveURL(/\/auth\/account\?notice=recovered&left=9/);

  // The same code again, on a third device: refused.
  const third = await browser.newContext();
  const again = await third.newPage();
  await again.goto(`${LOGIN}/auth/sign-in/code`);
  await again.getByLabel("Email").fill(email);
  await again.getByRole("button", { name: "Email me a code" }).click();
  await again.getByLabel("Code").fill(await codeFor(email, "sign-in"));
  await again.getByRole("button", { name: "Continue" }).click();
  await again.getByRole("link", { name: "Use a recovery code" }).click();
  await again.getByLabel("Recovery code").fill(recoveryCodes[0]!);
  await again.getByRole("button", { name: "Continue" }).click();
  await expect(again.getByRole("alert")).toContainText("not right");
  await third.close();

  // Sign out everywhere, from the second device: the first one's portal
  // session is gone on its next request.
  await phoneless.getByRole("button", { name: "Sign out on every device" }).click();
  await expect(phoneless).toHaveURL(/notice=signed-out-everywhere/);
  await second.close();
  await page.goto(`${APP}/dashboard`);
  await expect(page).toHaveURL(new RegExp(`^${LOGIN}/auth/sign-in`));
});

test("operator screen: invite, then a code is asked for once five minutes have passed, then reset an authenticator", async ({ page, browser }) => {
  await signInAsOperator(page);
  await page.goto(`${LOGIN}/auth/operator`);

  // Invite: the invited address can then get a code.
  const invited = `invited-${TAG}@test.invalid`;
  await page.getByLabel("Email", { exact: true }).first().fill(invited);
  await page.getByLabel("Business").selectOption(orgId);
  await page.getByLabel("Role").selectOption("owner");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("status")).toContainText(`Invited ${invited}`);
  const [inv] = await sql<{ role: string }>("select role from invitations where email = $1 and revoked_at is null", [invited]);
  expect(inv?.role).toBe("owner");

  // Five minutes later, each action needs a code from the authenticator.
  await sql(
    `update auth_sessions set mfa_verified_at = now() - interval '6 minutes'
      where user_id = (select id from auth_users where email = $1)`,
    [OPERATOR],
  );
  await page.goto(`${LOGIN}/auth/operator`);
  await expect(page.getByText("Each action asks for a code")).toBeVisible();

  // A person who lost their phone: reset their authenticator.
  const lost = await invite("lostphone");
  const theirs = await browser.newContext();
  const p = await theirs.newPage();
  await p.goto(`${LOGIN}/auth/sign-in/code`);
  await p.getByLabel("Email").fill(lost);
  await p.getByRole("button", { name: "Email me a code" }).click();
  await p.getByLabel("Code").fill(await codeFor(lost, "sign-in"));
  await p.getByRole("button", { name: "Continue" }).click();
  await enrolFromPage(p);

  const form = page.locator("form").filter({ hasText: "Reset authenticator" });
  // The code is required: the form cannot be sent without one.
  await expect(form.getByLabel("Authenticator code")).toHaveAttribute("required", "");

  const secret = await operatorSecret();
  await form.getByLabel("Email they sign in with").fill(lost);
  await form.getByLabel("Authenticator code").fill(await freshCode(secret));
  await form.getByRole("button", { name: /Reset authenticator/ }).click();
  await expect(page.getByRole("status")).toContainText(`Authenticator removed and every session ended for ${lost}`);

  // Their session is gone, and their next sign-in sets up a new authenticator.
  await p.goto(`${LOGIN}/auth/account`);
  await expect(p).toHaveURL(/\/auth\/sign-in/);
  const [factors] = await sql<{ n: number }>(
    "select count(*)::int as n from auth_two_factors where user_id = (select id from auth_users where email = $1)",
    [lost],
  );
  expect(factors?.n).toBe(0);
  await theirs.close();
});

test("send a new code: the newest works, the one before it does not; the emailed link resumes the handoff", async ({ page, context }) => {
  const email = await invite("resend");

  // Start from a portal deep link, so sign-in is resuming a handoff.
  await page.goto(`${APP}/jobs`);
  await page.getByRole("link", { name: "Email me a code instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const first = await codeFor(email, "sign-in");
  await page.getByRole("button", { name: "Send a new code" }).click();
  await expect(page.getByRole("status")).toContainText("A new code is on its way");
  let second = await codeFor(email, "sign-in");
  for (let i = 0; i < 20 && second === first; i++) {
    await new Promise((r) => setTimeout(r, 250));
    second = await codeFor(email, "sign-in");
  }
  expect(second).not.toBe(first);

  // Open the emailed link in a new tab: no `next` in it, but the handoff resumes.
  const tab = await context.newPage();
  await tab.goto(`${LOGIN}/auth/sign-in/code?email=${encodeURIComponent(email)}`);
  await tab.getByLabel("Code").fill(first);
  await tab.getByRole("button", { name: "Continue" }).click();
  await expect(tab.getByRole("alert")).toContainText("not right");
  await tab.getByLabel("Code").fill(second);
  await tab.getByRole("button", { name: "Continue" }).click();
  await enrolFromPage(tab);
  await tab.getByRole("button", { name: /saved them/ }).click();
  // Back on exactly the page the visit started from.
  await expect(tab).toHaveURL(`${APP}/jobs`);
});
