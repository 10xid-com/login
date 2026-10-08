import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { totpCode } from "./helpers";

/**
 * Agency access, end to end, in a real browser across both hosts: an agency
 * asks a business for access and names a person; the business's owner approves
 * the grant and the person; the person opens the business through the
 * switcher, under the agency banner, and works there. Then blocking, the
 * authenticator time limits, the audit record, revocation and expiry.
 *
 *   npx playwright test test/e2e/agency.spec.ts --project=chromium
 *
 * Everybody signs in for real (emailed code, then an authenticator they enrol
 * here), each in their own browser. Only the clock is moved, in the database:
 * how long ago a sign-in passed the authenticator, and a grant's end date.
 */

const LOGIN = `http://${process.env.E2E_PRIMARY_HOST ?? "login.portal-a.test:3000"}`;
const APP = `http://${process.env.E2E_APP_HOST ?? "app.portal-a.test:3001"}`;
const SINK = process.env.DEV_CODE_SINK ?? "/tmp/portal-signin-codes.log";
const TAG = `ag${Date.now().toString(36)}`;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

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

async function codeFor(email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const lines = (await readFile(SINK, "utf8").catch(() => "")).split("\n");
    const hit = lines.filter((l) => l.split("\t")[1] === email && l.split("\t")[3] === "sign-in").at(-1);
    if (hit) return hit.split("\t")[2]!;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no sign-in code for ${email}`);
}

/** Each 30-second step is accepted once, ever: wait for one not yet used. */
const lastStep = new Map<string, number>();
async function freshCode(secret: string): Promise<string> {
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

type Person = { email: string; page: Page; secret: string };

/** Invited into one organization at one role, then signed in for real, landing on the portal. */
async function person(browser: Browser, label: string, org: string, role: string): Promise<Person> {
  const email = `${label}-${TAG}@test.invalid`;
  const [inviter] = await sql<{ id: string }>("select id from users order by created_at limit 1");
  await sql(
    `insert into invitations (email, organization_id, role, invited_by, expires_at)
     values ($1, $2, $3, $4, now() + interval '7 days')`,
    [email, org, role, inviter!.id],
  );
  await sql("delete from auth_rate_limits");
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  await page.goto(`${APP}/dashboard`);
  await page.getByRole("link", { name: "Create your sign-in" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill(await codeFor(email));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/auth\/mfa\/setup/);
  if (await page.getByRole("button", { name: "Begin" }).isVisible()) {
    await page.getByRole("button", { name: "Begin" }).click();
  }
  const secret = (await page.locator("p.font-mono").innerText()).replace(/\s+/g, "");
  await page.getByLabel("Code").fill(await freshCode(secret));
  await page.getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("button", { name: /saved them/ }).click();
  await expect(page).toHaveURL(`${APP}/dashboard`);
  return { email, page, secret };
}

/** Move back the moment this person's sign-in last passed the authenticator. */
async function verifiedAgo(p: Person, interval: string) {
  await sql(
    `update auth_sessions set mfa_verified_at = now() - $2::interval
      where user_id = (select id from auth_users where email = $1)`,
    [p.email, interval],
  );
}

/** The "confirm it is you" page on the login host, then back to `back` on the portal. */
async function confirmItIsYou(p: Person, back: string) {
  await expect(p.page).toHaveURL(`${LOGIN}/auth/mfa/again?return=${encodeURIComponent(back)}`);
  await shot(p.page, `5-confirm-it-is-you${back.replace("/", "-")}`);
  await p.page.getByLabel("Code").fill(await freshCode(p.secret));
  await p.page.getByRole("button", { name: "Confirm" }).click();
  await expect(p.page).toHaveURL(`${APP}${back}`);
}

const businessRow = (page: Page, name: string) => page.locator("li", { hasText: name });

/** With AGENCY_SHOTS set to a directory, keep a full-page screenshot of the moment. */
async function shot(page: Page, name: string) {
  if (process.env.AGENCY_SHOTS) await page.screenshot({ path: `${process.env.AGENCY_SHOTS}/${name}.png`, fullPage: true });
}

test.describe.configure({ mode: "serial" });

test("agency access: ask, approve, open, block, time limits, audit, revoke, expire", async ({ browser }) => {
  test.setTimeout(900_000);

  const agencyName = `Agency ${TAG}`;
  const clientName = `Client ${TAG}`;
  const [agency] = await sql<{ id: string }>(
    "insert into organizations (type, name, slug, is_agency) values ('client', $1, $2, true) returning id",
    [agencyName, `${TAG}-agency`],
  );
  const [client] = await sql<{ id: string }>(
    "insert into organizations (type, name, slug) values ('client', $1, $2) returning id",
    [clientName, `${TAG}-client`],
  );

  const boss = await person(browser, "boss", agency!.id, "owner");
  const worker = await person(browser, "worker", agency!.id, "viewer");
  const second = await person(browser, "second", agency!.id, "viewer");
  const owner = await person(browser, "owner", client!.id, "owner");
  const manager = await person(browser, "manager", client!.id, "manager");

  await test.step("the agency asks for access and names a person", async () => {
    const p = boss.page;
    await p.goto(`${APP}/agency`);
    await p.getByLabel("Business reference").fill(`${TAG}-client`);
    await expect(p.getByLabel("Role")).toHaveValue("editor");
    await expect(p.getByLabel("Days (at most 365)")).toHaveValue("90");
    await p.getByLabel("Why").fill("Website and print work");
    await p.getByRole("button", { name: "Ask for access" }).click();
    await expect(p.getByRole("status")).toContainText("Asked.");
    await expect(p.getByText(`${clientName} · Editor · waiting for the business`)).toBeVisible();
    await p.getByLabel("Person").selectOption({ label: worker.email });
    await p.getByRole("button", { name: "Name", exact: true }).click();
    await expect(p.getByRole("status")).toContainText("Named.");
    await shot(p, "1-agency-asked-and-named");
  });

  await test.step("before approval the person reaches nothing", async () => {
    await worker.page.goto(`${APP}/business`);
    await expect(worker.page.getByText(clientName)).toHaveCount(0);
  });

  await test.step("a manager cannot approve; the owner approves the grant, then the person", async () => {
    await manager.page.goto(`${APP}/team`);
    await expect(manager.page.getByText(`${agencyName} asks for Editor access for 90 days`)).toBeVisible();
    await expect(manager.page.getByText("Waiting for an owner of this business to decide.")).toBeVisible();

    const p = owner.page;
    await p.goto(`${APP}/team`);
    await expect(p.getByText(`${agencyName} asks for Editor access for 90 days`)).toBeVisible();
    await shot(p, "2-owner-sees-request");
    await p.locator("form", { has: p.getByLabel("Days", { exact: true }) }).getByLabel("Days", { exact: true }).fill("30");
    await p.locator("form", { has: p.getByLabel("Days", { exact: true }) }).getByRole("button", { name: "Approve" }).click();
    await expect(p.getByRole("status")).toContainText("Approved.");
    await businessRow(p, worker.email).getByRole("button", { name: "Approve" }).click();
    await expect(p.getByRole("status")).toContainText("They can open this business");
  });

  await test.step("the person switches into the business, under the agency banner, and works there", async () => {
    const p = worker.page;
    await p.goto(`${APP}/business`);
    const row = businessRow(p, clientName);
    await expect(row).toContainText(`Editor · via ${agencyName}, until`);
    await shot(p, "3-switcher-via-agency");
    await row.getByRole("button", { name: "Open" }).click();
    await expect(p).toHaveURL(`${APP}/dashboard`);
    await expect(p.getByRole("status").filter({ hasText: "Working in" })).toContainText(
      `Working in ${clientName} for ${agencyName} · Editor · until`,
    );
    await shot(p, "4-banner-in-client");
    // Work: a job, filed into the client's business.
    await p.goto(`${APP}/jobs`);
    // The page's own form: Chat Boss's panel has a "Send" of its own.
    const page = p.getByRole("main");
    await page.getByLabel("Job title").fill(`Brochure ${TAG}`);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(p.getByText(`Brochure ${TAG}`)).toBeVisible();
    const [job] = await sql<{ organization_id: string }>("select organization_id from jobs where title = $1", [`Brochure ${TAG}`]);
    expect(job?.organization_id).toBe(client!.id);
    // Never the business's people or its agency decisions.
    await p.goto(`${APP}/team`);
    await expect(p.getByRole("heading", { name: "Agency access" })).toHaveCount(0);
    await expect(p.getByRole("button", { name: /Invite/ })).toHaveCount(0);
    // Never a membership.
    const members = await sql("select 1 from memberships m join users u on u.id = m.user_id where u.email = $1 and m.organization_id = $2", [
      worker.email,
      client!.id,
    ]);
    expect(members).toHaveLength(0);
  });

  await test.step("blocked: the manager blocks, the person loses the business; the owner unblocks", async () => {
    await manager.page.goto(`${APP}/team`);
    await businessRow(manager.page, worker.email).getByRole("button", { name: "Block" }).click();
    await expect(manager.page.getByRole("status")).toContainText("Blocked.");

    await worker.page.goto(`${APP}/dashboard`);
    await expect(worker.page.getByText(`Working in ${clientName}`)).toHaveCount(0);
    await worker.page.goto(`${APP}/business`);
    await expect(worker.page.getByText(clientName)).toHaveCount(0);

    await owner.page.goto(`${APP}/team`);
    await businessRow(owner.page, worker.email).getByRole("button", { name: "Unblock" }).click();
    await expect(owner.page.getByRole("status")).toContainText("They can open this business");
    await worker.page.goto(`${APP}/business`);
    await expect(businessRow(worker.page, clientName)).toContainText(`via ${agencyName}`);
  });

  await test.step("five minutes: approving waits for a fresh code; blocking does not", async () => {
    await boss.page.goto(`${APP}/agency`);
    await boss.page.getByLabel("Person").selectOption({ label: second.email });
    await boss.page.getByRole("button", { name: "Name", exact: true }).click();
    await expect(boss.page.getByRole("status")).toContainText("Named.");

    await verifiedAgo(owner, "10 minutes");
    await owner.page.goto(`${APP}/team`);
    await businessRow(owner.page, second.email).getByRole("button", { name: "Approve" }).click();
    await confirmItIsYou(owner, "/team");
    const [status] = await sql<{ status: string }>(
      `select p.status from agency_grant_people p join users u on u.id = p.user_id where u.email = $1`,
      [second.email],
    );
    expect(status?.status).toBe("requested");
    await businessRow(owner.page, second.email).getByRole("button", { name: "Approve" }).click();
    await expect(owner.page.getByRole("status")).toContainText("They can open this business");

    // Blocking, with a sign-in just as old, goes straight through.
    await verifiedAgo(manager, "10 minutes");
    await manager.page.goto(`${APP}/team`);
    await businessRow(manager.page, second.email).getByRole("button", { name: "Block" }).click();
    await expect(manager.page).toHaveURL(/\/team\?agency=person_blocked/);
  });

  await test.step("a day: agency access waits for a code from the last 24 hours", async () => {
    await verifiedAgo(worker, "25 hours");
    await worker.page.goto(`${APP}/dashboard`);
    await confirmItIsYou(worker, "/dashboard");
    await expect(worker.page.getByText(`Working in ${clientName} for ${agencyName}`)).toBeVisible();
  });

  await test.step("the audit record: the business's owners and managers see it, nobody else", async () => {
    for (const p of [owner.page, manager.page]) {
      await p.goto(`${APP}/team`);
      await p.getByText("Agency activity").click();
      const activity = p.locator("details", { hasText: "Agency activity" });
      for (const line of [
        `${boss.email} asked for access (Editor)`,
        `${owner.email} approved access (Editor, 30 days)`,
        `${boss.email} named ${worker.email}`,
        `${owner.email} approved ${worker.email}`,
        `${manager.email} blocked ${worker.email}`,
        `${owner.email} unblocked ${worker.email}`,
        `${worker.email} through agency access: jobs.create`,
      ]) {
        await expect(activity, line).toContainText(line);
      }
      if (p === owner.page) await shot(p, "6-audit-on-team");
    }
    await worker.page.goto(`${APP}/team`);
    await expect(worker.page.getByText("Agency activity")).toHaveCount(0);
    // Another business sees none of it.
    const elsewhere = await sql<{ n: number }>(
      "select count(*)::int as n from audit_events where agency_grant_id in (select id from agency_grants where client_organization_id = $1) and organization_id not in ($1, $2)",
      [client!.id, agency!.id],
    );
    expect(elsewhere[0]!.n).toBe(0);
  });

  await test.step("revocation: the manager ends access; everybody on it loses the business", async () => {
    await manager.page.goto(`${APP}/team`);
    await manager.page.getByRole("button", { name: "End access" }).click();
    await expect(manager.page.getByRole("status")).toContainText("Ended.");
    await worker.page.goto(`${APP}/dashboard`);
    await expect(worker.page.getByText(`Working in ${clientName}`)).toHaveCount(0);
    await worker.page.goto(`${APP}/business`);
    await expect(worker.page.getByText(clientName)).toHaveCount(0);
  });

  await test.step("expiry: a new grant, approved, then its date passes", async () => {
    await boss.page.goto(`${APP}/agency`);
    await boss.page.getByLabel("Business reference").fill(`${TAG}-client`);
    await boss.page.getByLabel("Why").fill("Second season of print work");
    await boss.page.getByRole("button", { name: "Ask for access" }).click();
    await expect(boss.page.getByRole("status")).toContainText("Asked.");
    const open = boss.page.locator("li", { hasText: "waiting for the business" });
    await open.getByLabel("Person").selectOption({ label: worker.email });
    await open.getByRole("button", { name: "Name", exact: true }).click();

    await verifiedAgo(owner, "0 seconds");
    await owner.page.goto(`${APP}/team`);
    await owner.page.locator("form", { has: owner.page.getByLabel("Days", { exact: true }) }).getByRole("button", { name: "Approve" }).click();
    await expect(owner.page.getByRole("status")).toContainText("Approved.");
    await businessRow(owner.page, worker.email).getByRole("button", { name: "Approve" }).first().click();
    await expect(owner.page.getByRole("status")).toContainText("They can open this business");

    await worker.page.goto(`${APP}/business`);
    await expect(businessRow(worker.page, clientName)).toContainText(`via ${agencyName}`);

    // Renewal opens in the last seven days, as a new request the owner decides on.
    const [live] = await sql<{ id: string }>(
      "select id from agency_grants where client_organization_id = $1 and status = 'active' and expires_at > now()",
      [client!.id],
    );
    await boss.page.goto(`${APP}/agency`);
    await expect(boss.page.getByRole("button", { name: "Ask to renew" })).toHaveCount(0);
    await sql("update agency_grants set expires_at = now() + interval '3 days' where id = $1", [live!.id]);
    await boss.page.goto(`${APP}/agency`);
    await boss.page.getByRole("button", { name: "Ask to renew" }).click();
    await expect(boss.page.getByRole("status")).toContainText("Asked to renew");
    await expect(boss.page.getByText(`${clientName} · Editor · renewal, waiting for the business`)).toBeVisible();
    await expect(boss.page.getByRole("button", { name: "Ask to renew" })).toHaveCount(0);

    // The link in the reminder email lands the owner on the grant.
    await owner.page.goto(`${APP}/grants/${live!.id}`);
    await expect(owner.page).toHaveURL(`${APP}/team#grant-${live!.id}`);
    await expect(owner.page.getByText(`${agencyName} asks to renew its Editor access`)).toBeVisible();
    await shot(owner.page, "7-renewal-on-team");

    await sql(
      "update agency_grants set expires_at = now() - interval '1 second' where client_organization_id = $1 and status = 'active'",
      [client!.id],
    );
    await worker.page.goto(`${APP}/business`);
    await expect(worker.page.getByText(clientName)).toHaveCount(0);
    await owner.page.goto(`${APP}/team`);
    await owner.page.getByText("Ended and declined").click();
    await expect(owner.page.locator("details", { hasText: "Ended and declined" })).toContainText(`${agencyName} · Editor · ended`);
  });
});
