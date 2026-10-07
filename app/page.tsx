import { redirect } from "next/navigation";
import { connection } from "next/server";
import { PORTAL_HOST, afterSignIn } from "@/lib/auth/sso";

/**
 * The login host has no pages of its own beyond sign-in. The portal is
 * 10xid-com/app, at PORTAL_HOST, and proxy.ts sends every other path there
 * before it reaches this file — so this is only reached when PORTAL_HOST is
 * not configured, and says so rather than redirecting in a circle.
 */
export default async function Home() {
  // Decided per request, never at build time: a build without PORTAL_HOST must
  // not bake "not configured" into a page that is configured when it runs.
  await connection();
  if (PORTAL_HOST) redirect(afterSignIn("/"));
  return (
    <main className="mx-auto max-w-md p-8 text-sm text-ink-soft">
      PORTAL_HOST is not configured, so there is nowhere to send you after
      signing in. Set it to the portal&apos;s host (app.10xid.com).
    </main>
  );
}
