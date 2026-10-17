import { redirect } from "next/navigation";
import { connection } from "next/server";
import { uidHomeForSession } from "@/lib/auth/login";
import { PORTAL_HOST, afterSignIn } from "@/lib/auth/sso";

/**
 * Where signing in ends. The login host has no pages of its own beyond
 * sign-in: proxy.ts sends every other path to the portal (10xid-com/app, at
 * PORTAL_HOST), except "/" for somebody signed in, which comes here. A person
 * with a UiD of their own (UID_HOMES, lib/auth/uid-home) goes to it; everybody
 * else goes to the portal. Without PORTAL_HOST this says so rather than
 * redirecting in a circle.
 */
export default async function Home() {
  // Decided per request, never at build time: a build without PORTAL_HOST must
  // not bake "not configured" into a page that is configured when it runs.
  await connection();
  const home = await uidHomeForSession();
  if (home) redirect(home);
  if (PORTAL_HOST) redirect(afterSignIn("/"));
  return (
    <main className="mx-auto max-w-md p-8 text-sm text-ink-soft">
      PORTAL_HOST is not configured, so there is nowhere to send you after
      signing in. Set it to the portal&apos;s host (app.10xid.com).
    </main>
  );
}
