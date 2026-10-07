import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * signInUrl() and afterSignIn() read PRIMARY_HOST and PORTAL_HOST when the
 * module loads, as the rest of lib/auth/sso does, so each case loads it fresh.
 */
async function load(env: { primary: string; portal: string }) {
  vi.resetModules();
  vi.stubEnv("PRIMARY_HOST", env.primary);
  vi.stubEnv("PORTAL_HOST", env.portal);
  vi.stubEnv("SESSION_COOKIE_SECURE", "true");
  return import("@/lib/auth/sso");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signInUrl", () => {
  test("is the login host's form by full address", async () => {
    const sso = await load({ primary: "login.10xid.com", portal: "app.10xid.com" });
    expect(sso.signInUrl()).toBe("https://login.10xid.com/auth/sign-in");
  });

  test("is a plain path when there is no login host configured", async () => {
    const sso = await load({ primary: "", portal: "" });
    expect(sso.signInUrl()).toBe("/auth/sign-in");
  });
});

describe("afterSignIn", () => {
  test("without a portal host, a path stays a path", async () => {
    const sso = await load({ primary: "login.10xid.com", portal: "" });
    expect(sso.afterSignIn("/jobs/1")).toBe("/jobs/1");
  });

  test("with a portal host, a portal path goes there", async () => {
    const sso = await load({ primary: "login.10xid.com", portal: "app.10xid.com" });
    expect(sso.afterSignIn("/")).toBe("https://app.10xid.com/");
    expect(sso.afterSignIn("/jobs/1?x=2")).toBe("https://app.10xid.com/jobs/1?x=2");
  });

  test("a handoff being resumed stays on the login host", async () => {
    const sso = await load({ primary: "login.10xid.com", portal: "app.10xid.com" });
    const resume = "/auth/sso/authorize?site=s&state=t";
    expect(sso.afterSignIn(resume)).toBe(resume);
  });

  test("a portal host equal to the login host changes nothing", async () => {
    const sso = await load({ primary: "login.10xid.com", portal: "login.10xid.com" });
    expect(sso.afterSignIn("/jobs")).toBe("/jobs");
  });
});
