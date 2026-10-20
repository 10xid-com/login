import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Dedicated Wrap Authority external integration: independent of portal SSO tickets. */
export const WA_AUDIENCE = "wrapauthority.net";
export const WA_CALLBACK = "https://wrapauthority.net/api/wrapauthority/10xid/callback";
export const WA_CODE_LIFETIME_MS = 60_000;
export const WA_STATE_LIFETIME_MS = 120_000;
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function makeOpaqueCode(): string {
  return randomBytes(32).toString("base64url");
}
export function strictWaCallback(value: unknown): boolean {
  return value === WA_CALLBACK;
}
export function constantTimeEquals(a: string, b: string): boolean {
  const aa=Buffer.from(a); const bb=Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa,bb);
}
/** Never accept a browser-provided account identifier or client callback origin. */
export function validateWaAuthorization(input: { clientId: string; redirectUri: string; state: string },
  expectedClientId: string): boolean {
  return !!expectedClientId &&
    constantTimeEquals(input.clientId,expectedClientId) &&
    strictWaCallback(input.redirectUri) &&
    /^[A-Za-z0-9_-]{24,256}$/.test(input.state);
}
