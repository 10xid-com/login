import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { integrationConfig } from "@/lib/wrapauthority/integration-config";
export const WA_AUDIENCE = "wrapauthority.net";
export const WA_CALLBACK = "https://wrapauthority.net/api/wrapauthority/10xid/callback";
export const WA_CODE_LIFETIME_MS = 60_000;
export const WA_STATE_LIFETIME_MS = 300_000;
export function waClient() {
  const config = integrationConfig();
  return config ? { ...config, callback: config.waOrigin + "/api/wrapauthority/10xid/callback", audience: new URL(config.waOrigin).hostname } : null;
}
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function makeOpaqueCode(): string { return randomBytes(32).toString("base64url"); }
export function strictWaCallback(value: unknown): boolean { return value === (waClient()?.callback ?? WA_CALLBACK); }
export function constantTimeEquals(a: string, b: string): boolean {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function validateWaAuthorization(input: { clientId: string; redirectUri: string; state: string }, expectedClientId: string): boolean {
  return !!expectedClientId && constantTimeEquals(input.clientId, expectedClientId) && strictWaCallback(input.redirectUri) && /^[A-Za-z0-9_-]{32,128}$/.test(input.state);
}
