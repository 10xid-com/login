import { createHmac, timingSafeEqual } from "node:crypto";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function seal(payload: object, key: string, purpose: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return data + "." + createHmac("sha256", key).update(purpose + "." + data).digest("base64url");
}
export function open(token: string, key: string, purpose: string, now = Date.now()): Record<string, unknown> | null {
  if (key.length < 32 || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0])) return null;
  const mac = createHmac("sha256", key).update(purpose + "." + parts[0]).digest("base64url");
  if (!equal(mac, parts[1])) return null;
  try {
    const body = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!body || typeof body !== "object" || !Number.isSafeInteger(body.exp) ||
        !Number.isSafeInteger(body.iat) || body.iat > now || body.exp <= now ||
        body.exp - body.iat > 300000 || body.exp <= body.iat) return null;
    return body;
  } catch { return null; }
}
export function jwtSessionId(token: string): string | null {
  // Call ONLY after Supabase getUser has verified this bearer.
  try {
    const id = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).session_id;
    return typeof id === "string" && UUID.test(id) ? id : null;
  } catch { return null; }
}
export function freshMfa(at: Date | null, now = Date.now()): boolean {
  return !!at && Number.isFinite(at.getTime()) && at.getTime() <= now && now - at.getTime() <= 300000;
}
