import "server-only";
import { and, eq, sql } from "drizzle-orm";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import {
  constantTimeEqual,
  generateRandomString,
  symmetricDecrypt,
  symmetricEncrypt,
} from "better-auth/crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import * as z from "zod";
import { authDb } from "@/lib/db/auth-connection";
import { authSessions, authTwoFactors } from "@/lib/db/schema";

/**
 * THE AUTHENTICATOR IS REQUIRED AFTER EVERY WAY OF SIGNING IN.
 *
 Better Auth's two-factor plugin is deliberately NOT used. It intercepts only
 * password sign-in, and only for a user whose `twoFactorEnabled` flag is set,
 * so a Google, Microsoft or emailed-code sign-in would walk straight past it;
 * its "trust this device" cookie skips it for thirty days; and its enable
 * endpoint can switch on emailed codes as the "second" factor.
 *
 * So the rule lives here instead, and it is one rule for every method: a
 * session is born with mfa_verified_at NULL (0022's trigger guarantees it,
 * whoever inserts the row), and until this plugin sets it, the session can do
 * nothing but finish signing in — every other endpoint answers 403. There is
 * exactly one path through, and it is an authenticator app (TOTP, RFC 6238).
 *
 * Verification here is stricter than the plugin's own session-mode check,
 * which has no lockout and no replay protection:
 *   * ten consecutive failures lock the account's factor for fifteen minutes;
 *   * a code is accepted for one 30-second step only once, ever;
 *   * recovery codes are compared in constant time and consumed under a row
 *     lock, so one code cannot be spent twice by racing requests.
 */

export const MFA_FRESH_SECONDS = 10 * 60;
const MAX_FAILURES = 10;
const LOCK_SECONDS = 15 * 60;
const RECOVERY_CODE_COUNT = 10;

/** Paths a session that has not passed the authenticator may still use. */
export const ALLOWED_BEFORE_MFA = new Set([
  "/get-session",
  "/ok",
  "/error",
  "/sign-out",
  "/sign-in/email",
  "/sign-in/email-otp",
  "/sign-in/social",
  "/callback/:id",
  "/sign-up/email",
  "/email-otp/send-verification-otp",
  "/email-otp/verify-email",
  "/email-otp/request-password-reset",
  "/email-otp/reset-password",
  "/mfa/start-enrollment",
  "/mfa/verify",
  "/mfa/confirm-enrollment",
  "/mfa/recover",
]);

const codeSchema = z.object({ code: z.string().trim().min(6).max(32) });

/** Which 30-second step a code belongs to, within one step either side; null if none. */
export async function matchingStep(secret: string, code: string, at = Date.now()): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const otp = createOTP(secret, { digits: 6, period: 30 });
  const current = Math.floor(at / 30_000);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const expected = await otp.hotp(step);
    if (constantTimeEqual(expected, code)) matched = step;
  }
  return matched;
}

/** A new authenticator secret: 20 random bytes, as authenticator apps expect. */
function newSecret(): string {
  return generateRandomString(32);
}

/** The otpauth:// address an authenticator app scans. */
export function otpauthUri(secret: string, accountName: string): string {
  const label = encodeURIComponent(`10XiD:${accountName}`);
  const encoded = base32.encode(secret, { padding: false });
  return `otpauth://totp/${label}?secret=${encoded}&issuer=10XiD&algorithm=SHA1&digits=6&period=30`;
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = generateRandomString(10, "a-z", "0-9");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

type Factor = typeof authTwoFactors.$inferSelect;

function isLocked(factor: Factor): boolean {
  return factor.lockedUntil !== null && factor.lockedUntil.getTime() > Date.now();
}

async function recordFailure(factorId: string) {
  await authDb()
    .update(authTwoFactors)
    .set({
      failedVerificationCount: sql`${authTwoFactors.failedVerificationCount} + 1`,
      lockedUntil: sql`case when ${authTwoFactors.failedVerificationCount} + 1 >= ${MAX_FAILURES}
        then now() + make_interval(secs => ${LOCK_SECONDS}) else ${authTwoFactors.lockedUntil} end`,
    })
    .where(eq(authTwoFactors.id, factorId));
}

const locked = () =>
  new APIError("TOO_MANY_REQUESTS", {
    message: "Too many incorrect codes. Try again in 15 minutes.",
    code: "MFA_LOCKED",
  });
const invalid = () =>
  new APIError("UNAUTHORIZED", { message: "That code is not right.", code: "MFA_INVALID_CODE" });

export const mfaGate = () =>
  ({
    id: "mfa-gate",
    hooks: {
      before: [
        {
          matcher: (ctx) => !ALLOWED_BEFORE_MFA.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (session && !(session.session as { mfaVerifiedAt?: Date | null }).mfaVerifiedAt) {
              throw new APIError("FORBIDDEN", {
                message: "Finish signing in with your authenticator first.",
                code: "MFA_REQUIRED",
              });
            }
          }),
        },
      ],
    },
    endpoints: {
      /**
       * Begin setting up an authenticator: a fresh secret, stored encrypted and
       * unconfirmed. Refused once one is confirmed — replacing a confirmed
       * authenticator is /mfa/reset-authenticator, which needs it first.
       * Starting again replaces only an unconfirmed secret.
       */
      mfaStartEnrollment: createAuthEndpoint(
        "/mfa/start-enrollment",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const { user } = ctx.context.session;
          // Only an identity whose address is proven may hold an authenticator
          // (and 0022 removes one if the address is proven later, by someone).
          if (!user.emailVerified) {
            throw new APIError("FORBIDDEN", {
              message: "Confirm your email address first.",
              code: "EMAIL_NOT_VERIFIED",
            });
          }
          const secret = newSecret();
          const encrypted = await symmetricEncrypt({ key: ctx.context.secretConfig, data: secret });
          const placeholder = await symmetricEncrypt({ key: ctx.context.secretConfig, data: "[]" });
          const outcome = await authDb().transaction(async (tx) => {
            const [existing] = await tx
              .select()
              .from(authTwoFactors)
              .where(eq(authTwoFactors.userId, user.id))
              .for("update");
            if (existing?.verified) return "enrolled" as const;
            if (existing) {
              await tx
                .update(authTwoFactors)
                .set({ secret: encrypted, backupCodes: placeholder, lastUsedStep: null })
                .where(eq(authTwoFactors.id, existing.id));
            } else {
              await tx.insert(authTwoFactors).values({
                id: generateRandomString(32),
                userId: user.id,
                secret: encrypted,
                backupCodes: placeholder,
                verified: false,
              });
            }
            return "ok" as const;
          });
          if (outcome === "enrolled") {
            throw new APIError("BAD_REQUEST", {
              message: "An authenticator is already set up.",
              code: "MFA_ALREADY_ENROLLED",
            });
          }
          return ctx.json({ totpURI: otpauthUri(secret, user.email) });
        },
      ),

      /** Step up an existing session with a code from the authenticator. */
      mfaVerify: createAuthEndpoint(
        "/mfa/verify",
        { method: "POST", body: codeSchema, use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const secretConfig = ctx.context.secretConfig;
          const outcome = await authDb().transaction(async (tx) => {
            const [factor] = await tx
              .select()
              .from(authTwoFactors)
              .where(and(eq(authTwoFactors.userId, user.id), eq(authTwoFactors.verified, true)))
              .for("update");
            if (!factor) return "not_enrolled" as const;
            if (isLocked(factor)) return "locked" as const;
            const secret = await symmetricDecrypt({ key: secretConfig, data: factor.secret });
            const step = await matchingStep(secret, ctx.body.code);
            if (step === null || (factor.lastUsedStep !== null && step <= factor.lastUsedStep)) {
              return { failed: factor.id };
            }
            await tx
              .update(authTwoFactors)
              .set({ failedVerificationCount: 0, lockedUntil: null, lastUsedStep: step })
              .where(eq(authTwoFactors.id, factor.id));
            await tx
              .update(authSessions)
              .set({ mfaVerifiedAt: new Date() })
              .where(eq(authSessions.id, session.id));
            return "ok" as const;
          });
          if (outcome === "not_enrolled") {
            throw new APIError("BAD_REQUEST", {
              message: "Set up your authenticator first.",
              code: "MFA_NOT_ENROLLED",
            });
          }
          if (outcome === "locked") throw locked();
          if (typeof outcome === "object") {
            await recordFailure(outcome.failed);
            throw invalid();
          }
          return ctx.json({ status: true });
        },
      ),

      /**
       * Confirm a new authenticator with its first code. The secret came from
       * /mfa/start-enrollment; it counts only once a code from the app matches
       * it. Recovery codes are generated here, after confirmation, and
       * returned this once.
       */
      mfaConfirmEnrollment: createAuthEndpoint(
        "/mfa/confirm-enrollment",
        { method: "POST", body: codeSchema, use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const secretConfig = ctx.context.secretConfig;
          const codes = generateRecoveryCodes();
          const encrypted = await symmetricEncrypt({ key: secretConfig, data: JSON.stringify(codes) });
          const outcome = await authDb().transaction(async (tx) => {
            const [factor] = await tx
              .select()
              .from(authTwoFactors)
              .where(and(eq(authTwoFactors.userId, user.id), eq(authTwoFactors.verified, false)))
              .for("update");
            if (!factor) return "no_pending" as const;
            const secret = await symmetricDecrypt({ key: secretConfig, data: factor.secret });
            const step = await matchingStep(secret, ctx.body.code);
            if (step === null) return "invalid" as const;
            await tx
              .update(authTwoFactors)
              .set({
                verified: true,
                lastUsedStep: step,
                backupCodes: encrypted,
                failedVerificationCount: 0,
                lockedUntil: null,
              })
              .where(eq(authTwoFactors.id, factor.id));
            await tx
              .update(authSessions)
              .set({ mfaVerifiedAt: new Date() })
              .where(eq(authSessions.id, session.id));
            return "ok" as const;
          });
          if (outcome === "no_pending") {
            throw new APIError("BAD_REQUEST", {
              message: "Start setting up your authenticator first.",
              code: "MFA_NO_PENDING_ENROLLMENT",
            });
          }
          if (outcome === "invalid") throw invalid();
          return ctx.json({ recoveryCodes: codes });
        },
      ),

      /** Pass the gate with a recovery code instead, consuming it. */
      mfaRecover: createAuthEndpoint(
        "/mfa/recover",
        { method: "POST", body: codeSchema, use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const secretConfig = ctx.context.secretConfig;
          const presented = ctx.body.code.trim().toLowerCase();
          const outcome = await authDb().transaction(async (tx) => {
            const [factor] = await tx
              .select()
              .from(authTwoFactors)
              .where(and(eq(authTwoFactors.userId, user.id), eq(authTwoFactors.verified, true)))
              .for("update");
            if (!factor) return "not_enrolled" as const;
            if (isLocked(factor)) return "locked" as const;
            const codes = JSON.parse(
              await symmetricDecrypt({ key: secretConfig, data: factor.backupCodes }),
            ) as string[];
            let index = -1;
            codes.forEach((code, i) => {
              if (constantTimeEqual(code.toLowerCase(), presented)) index = i;
            });
            if (index < 0) return { failed: factor.id, remaining: undefined };
            const remaining = codes.filter((_, i) => i !== index);
            await tx
              .update(authTwoFactors)
              .set({
                backupCodes: await symmetricEncrypt({
                  key: secretConfig,
                  data: JSON.stringify(remaining),
                }),
                failedVerificationCount: 0,
                lockedUntil: null,
              })
              .where(eq(authTwoFactors.id, factor.id));
            await tx
              .update(authSessions)
              .set({ mfaVerifiedAt: new Date() })
              .where(eq(authSessions.id, session.id));
            return { failed: undefined, remaining: remaining.length };
          });
          if (outcome === "not_enrolled") {
            throw new APIError("BAD_REQUEST", { message: "No authenticator is set up.", code: "MFA_NOT_ENROLLED" });
          }
          if (outcome === "locked") throw locked();
          if (outcome.failed !== undefined) {
            await recordFailure(outcome.failed);
            throw invalid();
          }
          return ctx.json({ status: true, remaining: outcome.remaining });
        },
      ),

      /** New recovery codes, replacing the old. Needs the authenticator within ten minutes. */
      mfaRegenerateRecoveryCodes: createAuthEndpoint(
        "/mfa/regenerate-recovery-codes",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          requireFresh(session);
          const codes = generateRecoveryCodes();
          const encrypted = await symmetricEncrypt({
            key: ctx.context.secretConfig,
            data: JSON.stringify(codes),
          });
          await authDb()
            .update(authTwoFactors)
            .set({ backupCodes: encrypted })
            .where(and(eq(authTwoFactors.userId, user.id), eq(authTwoFactors.verified, true)));
          return ctx.json({ recoveryCodes: codes });
        },
      ),

      /**
       * Replace a lost or changed authenticator: the old factor is removed and
       * this session must set up a new one before it can do anything else.
       * Needs the authenticator (or a recovery code) within ten minutes.
       */
      mfaResetAuthenticator: createAuthEndpoint(
        "/mfa/reset-authenticator",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          requireFresh(session);
          await authDb().transaction(async (tx) => {
            await tx.delete(authTwoFactors).where(eq(authTwoFactors.userId, user.id));
            await tx
              .update(authSessions)
              .set({ mfaVerifiedAt: null })
              .where(eq(authSessions.id, session.id));
          });
          return ctx.json({ status: true });
        },
      ),
    },
    rateLimit: [
      { pathMatcher: (path: string) => path.startsWith("/mfa/"), window: 60, max: 10 },
    ],
  }) satisfies BetterAuthPlugin;

function requireFresh(session: object) {
  const verifiedAt = (session as { mfaVerifiedAt?: Date | string | null }).mfaVerifiedAt;
  const at = verifiedAt ? new Date(verifiedAt).getTime() : 0;
  if (Date.now() - at > MFA_FRESH_SECONDS * 1000) {
    throw new APIError("FORBIDDEN", {
      message: "Confirm with your authenticator again first.",
      code: "MFA_NOT_FRESH",
    });
  }
}
