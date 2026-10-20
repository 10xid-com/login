import { redirect } from "next/navigation";
import { connection } from "next/server";
import { uidHomeForSession } from "@/lib/auth/login";
import { PORTAL_HOST, afterSignIn } from "@/lib/auth/sso";

/**
 * Where signing in ends. The login host has no pages of its own beyond
 * sign-in. A person with a UiD of their own (UID_HOMES, lib/auth/uid-home)
 * goes to it. Otherwise: the portal, while PORTAL_HOST names one; without it
 * — app.10xid.com signs people in itself, and nothing here sends anyone
 * there — this host's own account page, which asks a signed-out visitor to
 * sign in first.
 */
export default async function Home() {
  // Decided per request, never at build time: a build without PORTAL_HOST must
  // not bake one answer into a page that is configured differently when it runs.
  await connection();
  const home = await uidHomeForSession();
  if (home) redirect(home);
  if (PORTAL_HOST) redirect(afterSignIn("/"));
  redirect("/auth/account");
}
