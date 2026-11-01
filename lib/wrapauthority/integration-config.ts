/** Exact origins only; no request Host or forwarded header is trusted. */
export type IntegrationConfig = { waOrigin: string; loginOrigin: string; portalOrigin: string; environment: "staging" | "production" };
const production = { waOrigin: "https://wrapauthority.net", loginOrigin: "https://login.10xid.com", portalOrigin: "https://app.10xid.com" };
function stagingOrigin(value: string | undefined): string | null {
  try {
    const u = new URL(value || "");
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.pathname !== "/" || u.search || u.hash ||
        !/^(staging|stage|preview|test)[.-][a-z0-9.-]+$/i.test(u.hostname) ||
        Object.values(production).includes(u.origin)) return null;
    return u.origin;
  } catch { return null; }
}
export function integrationConfig(env: Record<string, string | undefined> = process.env): IntegrationConfig | null {
  if (env.WA_INTEGRATION_ENV === "production") return { ...production, environment: "production" };
  if (env.WA_INTEGRATION_ENV !== "staging") return null;
  const waOrigin = stagingOrigin(env.WA_STAGING_ORIGIN);
  const loginOrigin = stagingOrigin(env.WA_STAGING_LOGIN_ORIGIN);
  const portalOrigin = stagingOrigin(env.WA_STAGING_PORTAL_ORIGIN);
  if (!waOrigin || !loginOrigin || !portalOrigin || new Set([waOrigin, loginOrigin, portalOrigin]).size !== 3) return null;
  return { waOrigin, loginOrigin, portalOrigin, environment: "staging" };
}
export function waDatabaseAllowed(url: string | undefined, config: IntegrationConfig): boolean {
  try {
    const u = new URL(url || "");
    return u.origin === (config.environment === "staging"
      ? "https://ehejnxhznfnxoetnnhxg.supabase.co"
      : "https://mthhbumyytiblttjrjig.supabase.co");
  } catch { return false; }
}
