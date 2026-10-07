import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

/**
 * Where proxy.ts sends a request, for each host and path that matters.
 *
 * The rules are routing only — nothing here is a permission — but a mistake in
 * them is a redirect loop, or a sign-in form on a host that should never show
 * one, so every branch is pinned down.
 */

const LOGIN = "login.10xid.com";
const PORTAL = "app.10xid.com";
const CLIENT = "northstar.10xconnections.com";

function visit(host: string, path: string, opts: { session?: boolean } = {}) {
  const request = new NextRequest(`https://${host}${path}`, {
    headers: {
      host,
      ...(opts.session ? { cookie: "__Host-portal_session=opaque" } : {}),
    },
  });
  return proxy(request);
}

/** The redirect target, or null when the request is let through. */
function target(response: Response): string | null {
  return response.headers.get("location");
}

beforeEach(() => {
  vi.stubEnv("PRIMARY_HOST", LOGIN);
  vi.stubEnv("SESSION_COOKIE_SECURE", "true");
  vi.stubEnv("PORTAL_HOST", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("without PORTAL_HOST: the login host is also the portal", () => {
  test("a portal page on the login host is served there", () => {
    expect(target(visit(LOGIN, "/dashboard", { session: true }))).toBeNull();
    expect(target(visit(LOGIN, "/dashboard"))).toBeNull();
  });

  test("a client domain with no cookie starts the handoff", () => {
    expect(target(visit(CLIENT, "/jobs?x=1"))).toBe(
      `https://${CLIENT}/auth/sso/start?path=%2Fjobs%3Fx%3D1`,
    );
  });
});

describe("with PORTAL_HOST: the login host keeps only sign-in", () => {
  beforeEach(() => vi.stubEnv("PORTAL_HOST", PORTAL));

  test("a signed-in visit to a portal page is sent to the portal host", () => {
    expect(target(visit(LOGIN, "/jobs/123?tab=files", { session: true }))).toBe(
      `https://${PORTAL}/jobs/123?tab=files`,
    );
    expect(target(visit(LOGIN, "/", { session: true }))).toBe(
      `https://${PORTAL}/`,
    );
  });

  test("a signed-out visit is asked to sign in first, keeping the path", () => {
    expect(target(visit(LOGIN, "/jobs/123"))).toBe(
      `https://${LOGIN}/auth/sign-in?next=%2Fjobs%2F123`,
    );
  });

  test("the sign-in screens and the handoff stay on the login host", () => {
    for (const path of [
      "/auth/sign-in",
      "/auth/verify-email?email=a%40b.test",
      "/auth/mfa",
      "/auth/sso/authorize?site=x&state=y",
    ]) {
      expect(target(visit(LOGIN, path))).toBeNull();
      expect(target(visit(LOGIN, path, { session: true }))).toBeNull();
    }
  });

  test("the portal host with no cookie starts the handoff, like any destination", () => {
    expect(target(visit(PORTAL, "/dashboard"))).toBe(
      `https://${PORTAL}/auth/sso/start?path=%2Fdashboard`,
    );
  });

  test("the portal host with a cookie serves the portal", () => {
    expect(target(visit(PORTAL, "/dashboard", { session: true }))).toBeNull();
  });

  test("the handoff's own steps are left alone on the portal host", () => {
    expect(target(visit(PORTAL, "/auth/sso/start?path=%2F"))).toBeNull();
    expect(target(visit(PORTAL, "/auth/sso/callback?ticket=t&state=s"))).toBeNull();
  });

  test("machine endpoints answer on every host, never with a redirect", () => {
    expect(target(visit(LOGIN, "/api/v1/jobs"))).toBeNull();
    expect(target(visit(PORTAL, "/api/v1/jobs"))).toBeNull();
  });

  test("a PORTAL_HOST equal to the login host changes nothing", () => {
    vi.stubEnv("PORTAL_HOST", LOGIN);
    expect(target(visit(LOGIN, "/dashboard", { session: true }))).toBeNull();
  });
});

describe("sign-in screens exist on the login host only", () => {
  for (const portal of ["", PORTAL]) {
    test(`elsewhere they forward to it (PORTAL_HOST=${portal || "unset"})`, () => {
      vi.stubEnv("PORTAL_HOST", portal);
      // Signing out of the portal lands here.
      expect(target(visit(PORTAL, "/auth/sign-in"))).toBe(
        `https://${LOGIN}/auth/sign-in`,
      );
      expect(target(visit(CLIENT, "/auth/sign-up?next=%2F"))).toBe(
        `https://${LOGIN}/auth/sign-up?next=%2F`,
      );
      expect(target(visit(PORTAL, "/auth/verify-email?email=a%40b.test", { session: true }))).toBe(
        `https://${LOGIN}/auth/verify-email?email=a%40b.test`,
      );
    });
  }

  test("with no PRIMARY_HOST at all, nothing is redirected", () => {
    vi.stubEnv("PRIMARY_HOST", "");
    expect(target(visit(PORTAL, "/auth/sign-in"))).toBeNull();
  });
});

describe("the healthcheck", () => {
  test("is answered on every host, signed in or not, and never redirected", () => {
    vi.stubEnv("PORTAL_HOST", PORTAL);
    for (const host of [LOGIN, PORTAL, CLIENT]) {
      expect(target(visit(host, "/healthz"))).toBeNull();
    }
  });
});
