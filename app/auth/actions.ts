"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requestSignInCode, verifySignInCode } from "@/lib/auth/codes";
import {
  currentHost,
  startSession,
  writeSessionCookie,
} from "@/lib/auth/session";
import { SESSION_POLICY } from "@/lib/auth/policy";
import { afterSignIn } from "@/lib/auth/sso";

/**
 * A "where were you going" value is always a PATH on this host, never a URL.
 *
 * Accepting a URL here is how sign-in pages get turned into open redirects that
 * launder a phishing link through a domain the victim trusts. The checks below
 * reject anything that is not plainly a local path — including the
 * protocol-relative `//evil.test` form, which a naive "starts with /" test
 * lets straight through.
 */
function safePath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) return "/";
  if (!input.startsWith("/")) return "/";
  if (input.startsWith("//")) return "/";
  if (input.includes("\\")) return "/";
  if (/[\p{Cc}]/u.test(input)) return "/";
  return input;
}

function clientIp(h: Headers): string | null {
  // Behind Cloudflare and Railway the leftmost x-forwarded-for entry is
  // whatever the caller chose to send, so it is never trusted. Prefer the
  // platform-set header, and otherwise take the LAST hop, which was appended
  // by the nearest proxy rather than supplied by the client.
  const cf = h.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = h.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",");
    return parts[parts.length - 1]!.trim();
  }
  return null;
}

const emailSchema = z.string().trim().toLowerCase().email().max(320);

/**
 * One box, three shapes of thing that can go in it.
 *
 * Six digits is an emailed code or an authenticator code — which of those it is
 * depends on the account, and is decided on the server so the form gives
 * nothing away. Eight characters, optionally hyphenated, is a recovery code.
 *
 * Deliberately permissive rather than clever: anything that does not match is
 * rejected identically to a wrong code, so the shape of what was typed is not
 * itself an answer.
 */
const codeSchema = z
  .string()
  .trim()
  .regex(/^(\d{6}|[0-9A-Za-z]{4}-?[0-9A-Za-z]{4})$/);

export async function requestCodeAction(formData: FormData) {
  const parsed = emailSchema.safeParse(formData.get("email"));
  const next = safePath(formData.get("next"));

  if (!parsed.success) {
    redirect(`/auth/login?error=email&next=${encodeURIComponent(next)}`);
  }

  const outcome = await requestSignInCode(
    parsed.data,
    clientIp(await headers()),
  );

  if (outcome === "rate_limited") {
    redirect(
      `/auth/login?error=rate&next=${encodeURIComponent(next)}&email=${encodeURIComponent(parsed.data)}`,
    );
  }

  redirect(
    `/auth/verify?email=${encodeURIComponent(parsed.data)}&next=${encodeURIComponent(next)}`,
  );
}

export async function verifyCodeAction(formData: FormData) {
  const email = emailSchema.safeParse(formData.get("email"));
  const code = codeSchema.safeParse(formData.get("code"));
  const next = safePath(formData.get("next"));

  if (!email.success || !code.success) {
    redirect(
      `/auth/verify?email=${encodeURIComponent(String(formData.get("email") ?? ""))}&next=${encodeURIComponent(next)}&error=invalid`,
    );
  }

  const result = await verifySignInCode(email.data, code.data);

  if (!result.ok) {
    redirect(
      `/auth/verify?email=${encodeURIComponent(email.data)}&next=${encodeURIComponent(next)}&error=${result.reason}`,
    );
  }

  const host = await currentHost();
  const { token, role } = await startSession({
    userId: result.userId,
    host,
    secondFactorPassed: result.secondFactorPassed,
  });

  await writeSessionCookie(
    token,
    new Date(Date.now() + SESSION_POLICY[role].absoluteSeconds * 1000),
  );

  redirect(afterSignIn(next));
}
