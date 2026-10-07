/**
 * The platform healthcheck (Railway: healthcheck path /healthz).
 *
 * Unauthenticated, and says nothing but that the process is serving: no
 * database round trip (a database blip should not get every instance
 * restarted), no version, no configuration, no secrets.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
