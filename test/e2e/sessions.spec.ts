import { expect, test } from "@playwright/test";
import { resetSignInState, signIn } from "./helpers";

/**
 * "Your sessions — sign out other devices."
 *
 * The cheapest incident-response tool there is: a laptop left on a train stops
 * mattering after one click, with nobody needing database access. It works
 * because sessions live server-side, so revoking one takes effect on the very
 * next request rather than whenever a token happens to expire.
 */

const CLIENT = "jane@rotary.test";
const ROTARY = "http://rotary.portal-b.test:3000";

test.describe("active sessions", () => {
  test.beforeEach(resetSignInState);

  test("lists this device, and says which one it is", async ({ page }) => {
    await signIn(page, CLIENT, "/account/sessions");

    await expect(page.getByRole("heading", { name: "Your sessions" })).toBeVisible();
    await expect(page.getByText("login.portal-a.test:3000")).toBeVisible();
    await expect(page.getByText("this device")).toBeVisible();
  });

  // Listed under this device rather than as another one: the browser holds a
  // session on each domain it was handed to, and they are one device (0020).
  test("a session on another domain is listed, under this device", async ({ page }) => {
    await signIn(page, CLIENT, "/jobs");

    // Cross to the client domain, which establishes its own first-party session.
    await page.goto(`${ROTARY}/jobs`);
    await page.waitForLoadState("load");

    await page.goto("/account/sessions");
    await expect(page.getByText("login.portal-a.test:3000")).toBeVisible();
    await expect(page.getByText("rotary.portal-b.test:3000")).toBeVisible();
  });

  test("signing out other devices ends them and leaves this one working", async ({
    page,
    browser,
  }) => {
    // A genuinely separate browser context is a genuinely separate device: its
    // own cookie jar, its own sessions. Two tabs in one browser would not do —
    // revoking a session there and revisiting simply performs a fresh handoff,
    // because that browser still holds a live session at the login host.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, CLIENT, "/jobs");
    await expect(otherPage.getByRole("heading", { name: "Jobs" })).toBeVisible();

    await signIn(page, CLIENT, "/account/sessions");
    await expect(page.getByRole("button", { name: /Sign out 1 other/ })).toBeVisible();
    await page.getByRole("button", { name: /Sign out 1 other/ }).click();
    await page.waitForURL(/done=others/);

    // This device still works.
    await expect(page.getByText("this device")).toBeVisible();
    await page.goto("/jobs");
    await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();

    // The other device is signed out on its very next request — no waiting for
    // a token to expire, because the session row it pointed at is revoked.
    await otherPage.goto("/jobs");
    await otherPage.waitForLoadState("load");
    expect(otherPage.url()).toContain("/auth/login");

    await other.close();
  });

  test("signing out this device ends it immediately", async ({ page }) => {
    await signIn(page, CLIENT, "/account/sessions");

    await page.getByRole("button", { name: "Sign out here" }).click();
    await page.waitForURL(/\/auth\/login/);

    await page.goto("/jobs");
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});
