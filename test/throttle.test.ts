import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "pg";

/**
 * The sign-in pages' own rate limits (lib/auth/throttle.ts). Better Auth's
 * limits run only for HTTP calls to /api/auth; the pages call it in-process,
 * so these are what stand between a form and unlimited guessing.
 */

const ip = vi.hoisted(() => ({ value: "203.0.113.7" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": ip.value }),
}));

const { allow, LIMITS } = await import("@/lib/auth/throttle");
const { closeAuthPool } = await import("@/lib/db/auth-connection");
const owner = new Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await owner.connect();
});

beforeEach(async () => {
  await owner.query("delete from auth_rate_limits where key like 'action:%'");
  ip.value = "203.0.113.7";
});

afterAll(async () => {
  await owner.end();
  await closeAuthPool();
});

describe("action limits", () => {
  test("per address being tried: the sixth code request in ten minutes is refused", async () => {
    const results = [];
    for (let i = 0; i < LIMITS.requestCode.subject.max + 1; i++) {
      ip.value = `198.51.100.${i}`; // a different client each time
      results.push(await allow("requestCode", "victim@test.invalid"));
    }
    expect(results.slice(0, LIMITS.requestCode.subject.max).every(Boolean)).toBe(true);
    expect(results.at(-1)).toBe(false);
  });

  test("per client: one address cannot spray many accounts", async () => {
    const results = [];
    for (let i = 0; i < LIMITS.password.ip.max + 1; i++) {
      results.push(await allow("password", `person${i}@test.invalid`));
    }
    expect(results.at(-1)).toBe(false);
  });

  test("parallel attempts are counted exactly", async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, () => allow("mfa", "auth-user-1")),
    );
    expect(results.filter(Boolean)).toHaveLength(LIMITS.mfa.subject.max);
  });

  test("the window resets", async () => {
    for (let i = 0; i < LIMITS.requestReset.subject.max; i++) await allow("requestReset", "w@test.invalid");
    expect(await allow("requestReset", "w@test.invalid")).toBe(false);
    await owner.query(
      "update auth_rate_limits set last_request = last_request - 3600000 where key like 'action:requestReset:%'",
    );
    expect(await allow("requestReset", "w@test.invalid")).toBe(true);
  });
});
