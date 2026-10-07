import "server-only";
import { cookies } from "next/headers";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { getAuth } from "./auth";

/**
 * Recovery codes are shown once, on their own page, right after they are
 * made — never in a URL, never stored where the next visitor could read them.
 *
 * They travel from the action that made them to that page in a cookie that is
 * encrypted with the sign-in secret, HttpOnly, host-only, scoped to that one
 * path and dead after ten minutes; "I have saved them" deletes it. The stored
 * copies (auth_two_factors.backup_codes) are encrypted the same way.
 */

const SECURE = process.env.SESSION_COOKIE_SECURE !== "false";
const NAME = SECURE ? "__Secure-10xid.recovery_codes" : "10xid.recovery_codes";
const PATH = "/auth/mfa/recovery-codes";

export async function showRecoveryCodesOnce(codes: string[]): Promise<void> {
  const { secretConfig } = await getAuth().$context;
  const sealed = await symmetricEncrypt({ key: secretConfig, data: JSON.stringify(codes) });
  (await cookies()).set(NAME, sealed, {
    httpOnly: true,
    secure: SECURE,
    sameSite: "strict",
    path: PATH,
    maxAge: 10 * 60,
  });
}

export async function readRecoveryCodes(): Promise<string[] | null> {
  const sealed = (await cookies()).get(NAME)?.value;
  if (!sealed) return null;
  try {
    const { secretConfig } = await getAuth().$context;
    const codes = JSON.parse(await symmetricDecrypt({ key: secretConfig, data: sealed }));
    return Array.isArray(codes) ? codes.filter((c): c is string => typeof c === "string") : null;
  } catch {
    return null;
  }
}

export async function forgetRecoveryCodes(): Promise<void> {
  (await cookies()).set(NAME, "", { httpOnly: true, secure: SECURE, sameSite: "strict", path: PATH, maxAge: 0 });
}
