import { describe, expect, it } from "vitest";
import { constantTimeEquals, digest, makeOpaqueCode, strictWaCallback, validateWaAuthorization, WA_CALLBACK } from "../lib/auth/wa-external";

describe("WA external authorization guardrails", () => {
  const clientId = "wa-confidential-client";
  const state = "a".repeat(32);
  it("accepts only its fixed callback and exact client ID", () => {
    expect(validateWaAuthorization({ clientId, redirectUri: WA_CALLBACK, state }, clientId)).toBe(true);
    for (const redirectUri of ["https://evil.test", "https://wrapauthority.net.evil.test/api/wrapauthority/10xid/callback", "http://wrapauthority.net/api/wrapauthority/10xid/callback", "https://wrapauthority.net/api/wrapauthority/10xid/callback?next=evil"]) {
      expect(validateWaAuthorization({ clientId, redirectUri, state }, clientId)).toBe(false);
    }
  });
  it("rejects substitutions and weak state", () => {
    expect(validateWaAuthorization({ clientId: "other", redirectUri: WA_CALLBACK, state }, clientId)).toBe(false);
    expect(validateWaAuthorization({ clientId, redirectUri: WA_CALLBACK, state: "short" }, clientId)).toBe(false);
  });
  it("creates non-repeating opaque codes and hashes them", () => {
    const a = makeOpaqueCode(), b = makeOpaqueCode();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(digest(a)).not.toBe(a);
    expect(constantTimeEquals(digest(a), digest(a))).toBe(true);
    expect(constantTimeEquals(digest(a), digest(b))).toBe(false);
  });
});
