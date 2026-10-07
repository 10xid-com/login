import { expect, test, type Page } from "@playwright/test";
import {
  expectSignedIn,
  latestCodeFor,
  latestSessionFor,
  openAccountMenu,
  passSecondFactor,
  resetSignInState,
  settle,
  signIn,
} from "./helpers";

/**
 * The portal on a host of its own (PORTAL_HOST), with the login host keeping
 * nothing but sign-in.
 *
 * Only meaningful when the dev server was started with PORTAL_HOST set, so the
 * spec skips itself otherwise:
 *
 *   PORTAL_HOST=app.portal-a.test:3000 npx playwright test portal-host
 *
 * app.portal-a.test is a sibling of login.portal-a.test, as app.10xid.com is of
 * login.10xid.com. The session cookie is __Host- prefixed and so cannot be
 * shared between them; the portal host gets its own through the handoff, which
 * is what these tests prove happens without a second prompt.
 */

const PORTAL_HOST = process.env.PORTAL_HOST ?? "";
const LOGIN_HOST = process.env.E2E_PRIMARY_HOST ?? "login.portal-a.test:3000";
const PORTAL = `http://${PORTAL_HOST}`;
const LOGIN = `http://${LOGIN_HOST}`;

const CLIENT = "jane@rotary.test";
const STAFF = "paolo@brandingcentres.test";

test.skip(!PORTAL_HOST, "PORTAL_HOST is not set for this run");

function recordHops(page: Page) {
  const hops: string[] = [];
  page.on("request", (req) => {
    if (req.resourceType() === "document") hops.push(req.url());
  });
  return hops;
}

const hostOf = (url: string) => new URL(url).host;

test.describe("the portal on its own host", () => {
  test.beforeEach(resetSignInState);

  test("signing in at the login host lands on the portal host, signed in", async ({
    page,
  }) => {
    const hops = recordHops(page);
    await signIn(page, CLIENT);

    expect(hostOf(page.url())).toBe(PORTAL_HOST);
    await expectSignedIn(page);

    // The way there was the ordinary handoff, and no portal page was ever
    // rendered on the login host.
    expect(hops.some((h) => h.includes("/auth/sso/callback"))).toBe(true);
    // Sign-in hands over by full address, so the login host is never even
    // asked for a portal page on the way.
    const portalPagesOnLogin = hops.filter(
      (h) => hostOf(h) === LOGIN_HOST && !new URL(h).pathname.startsWith("/auth/"),
    );
    expect(portalPagesOnLogin).toEqual([]);

    // The session the portal runs on was issued for the portal host.
    const session = await latestSessionFor(CLIENT);
    expect(session?.issued_for_host).toBe(PORTAL_HOST);
  });

  test("a deep link to the portal survives the sign-in", async ({ page }) => {
    await page.goto(`${PORTAL}/jobs?from=email`);

    // Sent to the login host to sign in — the portal host has no form.
    await page.waitForURL(/\/auth\/login/);
    expect(hostOf(page.url())).toBe(LOGIN_HOST);

    await page.getByLabel("Email").fill(CLIENT);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(CLIENT));
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL((u) => u.host === PORTAL_HOST && u.pathname === "/jobs");
    expect(new URL(page.url()).searchParams.get("from")).toBe("email");
    await expectSignedIn(page);
  });

  test("a portal page asked for on the login host opens on the portal host", async ({
    page,
  }) => {
    await signIn(page, CLIENT);
    await page.goto(`${LOGIN}/dashboard`);
    await settle(page);
    expect(hostOf(page.url())).toBe(PORTAL_HOST);
    expect(new URL(page.url()).pathname).toBe("/dashboard");
    await expectSignedIn(page);
  });

  test("staff finish their second step on the login host, not the portal", async ({
    page,
  }) => {
    const hops = recordHops(page);
    await signIn(page, STAFF);

    expect(hostOf(page.url())).toBe(PORTAL_HOST);
    await expectSignedIn(page);

    const secondStep = hops.filter((h) => new URL(h).pathname === "/auth/2fa");
    expect(secondStep.length).toBeGreaterThan(0);
    for (const h of secondStep) expect(hostOf(h)).toBe(LOGIN_HOST);

    // And the portal's session arrived with it already cleared.
    await page.goto(`${PORTAL}/chat`);
    await settle(page);
    expect(new URL(page.url()).pathname).not.toBe("/auth/2fa");
    await passSecondFactor(page).then((key) => expect(key).toBeNull());
  });

  test("signing out of the portal ends at the login host's sign-in form", async ({
    page,
  }) => {
    await signIn(page, CLIENT);
    expect(hostOf(page.url())).toBe(PORTAL_HOST);

    await openAccountMenu(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/auth\/login/);
    expect(hostOf(page.url())).toBe(LOGIN_HOST);

    // Signed out everywhere: the portal asks again, via the login host.
    await page.goto(`${PORTAL}/dashboard`);
    await page.waitForURL(/\/auth\/login/);
    expect(hostOf(page.url())).toBe(LOGIN_HOST);
  });

  test("the login host's session and the portal's are one device", async ({ page }) => {
    await signIn(page, CLIENT, "/account/sessions");
    expect(hostOf(page.url())).toBe(PORTAL_HOST);

    // Listed together, as this device, and not counted as another one.
    await expect(page.getByText(LOGIN_HOST)).toBeVisible();
    await expect(page.getByText(PORTAL_HOST)).toBeVisible();
    await expect(page.getByText("this device")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Sign out \d+ other/ })).toHaveCount(0);

    // "Sign out here" ends both, so the login host cannot quietly hand the
    // browser straight back in.
    await page.getByRole("button", { name: "Sign out here" }).click();
    await page.waitForURL(/\/auth\/login/);
    await page.goto(`${PORTAL}/dashboard`);
    await page.waitForURL(/\/auth\/login/);
    expect(hostOf(page.url())).toBe(LOGIN_HOST);
    await expect(page.getByLabel("Email")).toBeVisible();
  });
});
