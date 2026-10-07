import "server-only";
import { cookies } from "next/headers";
import { safeNext } from "./login";

/**
 * Where sign-in was resuming to, kept on this browser while an emailed code
 * is on its way.
 *
 * The email links to the code page without the handoff it interrupted (the
 * link must not carry anything but the address), so opening it in a new tab
 * would otherwise land on the portal's front page instead of where the person
 * was going. The same safeNext() allow-list applies on the way in and out:
 * only a handoff or the account page, never an address elsewhere. Same
 * browser only, for fifteen minutes.
 */

const SECURE = process.env.SESSION_COOKIE_SECURE !== "false";
const NAME = SECURE ? "__Secure-10xid.resume" : "10xid.resume";

export async function rememberResume(next: string): Promise<void> {
  if (next === "/") return;
  (await cookies()).set(NAME, next, {
    httpOnly: true,
    secure: SECURE,
    sameSite: "lax",
    path: "/auth",
    maxAge: 15 * 60,
  });
}

/** The page's own `next`, or the remembered one, re-validated. */
export async function resumeFor(fromQuery: string | undefined): Promise<string> {
  if (fromQuery) return safeNext(fromQuery);
  return safeNext((await cookies()).get(NAME)?.value);
}
