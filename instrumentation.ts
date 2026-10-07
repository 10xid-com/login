/**
 * Runs once when a server instance starts, before it handles any request.
 *
 * The tenant-isolation design rests on the application connecting as a
 * restricted database role. If it ever connects as the owner or a superuser,
 * Postgres silently ignores every row-level security policy — no error, no
 * warning, and every client can read every other client's data.
 *
 * Silent is the problem. So the check runs here, at startup, and refuses to let
 * a misconfigured deployment serve traffic at all rather than serving it
 * unsafely. The function existed before this file did and was never called,
 * which made the guarantee a comment rather than a guard.
 */
export async function register() {
  // Only the Node.js runtime can reach the database; the edge runtime cannot.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertRestrictedRole } = await import("./lib/db/connection");
  await assertRestrictedRole();
  console.log("[startup] database role verified: not privileged, RLS applies");

  // The sign-in engine: its own restricted role, and its secret.
  const secret = process.env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32) {
    throw new Error("Refusing to start: BETTER_AUTH_SECRET must be set, at least 32 characters.");
  }
  if (!process.env.PRIMARY_HOST) {
    throw new Error("Refusing to start: PRIMARY_HOST (the login host) must be set.");
  }
  const { assertAuthRole } = await import("./lib/db/auth-connection");
  await assertAuthRole();
  console.log("[startup] sign-in role verified: portal_auth, no BYPASSRLS, no portal tables");
}
