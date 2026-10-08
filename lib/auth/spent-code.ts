import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * The emailed sign-in code this browser just used, so the authenticator step
 * can recognise it when it is typed there by mistake.
 *
 * Phones offer the emailed code again on the next screen ("From Mail", "From
 * Outlook"), and people take it. That code has already done its job — proving
 * the mailbox — and is spent; the authenticator step needs the app's code.
 * Recognising it lets the page say so, instead of a bare "not right", and
 * without counting it as a failed authenticator attempt.
 *
 * Kept as an HMAC under the server's secret, never the code, on this browser
 * only, under /auth, for fifteen minutes. A spent code is worthless anyway; the
 * HMAC just keeps it out of the cookie jar.
 */

const SECURE = process.env.SESSION_COOKIE_SECURE !== "false";
const NAME = SECURE ? "__Secure-10xid.spent-code" : "10xid.spent-code";

function mac(code: string): Buffer {
  return createHmac("sha256", process.env.BETTER_AUTH_SECRET ?? "")
    .update(`spent-sign-in-code:${code}`)
    .digest();
}

export async function rememberSpentCode(code: string): Promise<void> {
  (await cookies()).set(NAME, mac(code).toString("base64url"), {
    httpOnly: true,
    secure: SECURE,
    sameSite: "lax",
    path: "/auth",
    maxAge: 15 * 60,
  });
}

/** Is this the emailed code this browser signed in with in the last fifteen minutes? */
export async function isSpentCode(code: string): Promise<boolean> {
  const stored = (await cookies()).get(NAME)?.value;
  if (!stored) return false;
  const expected = mac(code);
  const actual = Buffer.from(stored, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
