import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { authDb } from "@/lib/db/auth-connection";
import { eq } from "drizzle-orm";
import { mayCreateSignIn, normalizeEmail, userByAuthUserId } from "@/lib/db/accounts";
import {
  authAccounts,
  authRateLimits,
  authSessions,
  authUsers,
  authVerifications,
} from "@/lib/db/schema";
import { sendAuthCode } from "./mailer";
import { mfaGate } from "./mfa-gate";
import { PRIMARY_HOST, originFor } from "./sso";

/**
 * SIGN-IN, SELF-HOSTED: Better Auth on the login host.
 *
 * Runs only in this service (login.10xid.com), under /api/auth, against its
 * own tables through its own restricted role (portal_auth). Its session cookie
 * is host-only — no Domain attribute, crossSubDomainCookies left off — so it is
 * never sent to app.10xid.com or to any other subdomain. The portal receives a
 * session of its own through the single-use ticket handoff instead.
 *
 * What a sign-in proves and what it does not:
 *   * it proves who somebody is — a password, an emailed code, or Google /
 *     Microsoft — and then, ALWAYS, an authenticator app (lib/auth/mfa-gate);
 *   * it grants nothing in the portal. An identity is tied to a portal account
 *     only by an invitation made out to exactly its verified address, or by an
 *     operator (lib/auth/account.ts), and what the account may do is decided by
 *     the portal's central authorization function, per request.
 *
 * The session clocks — seven days from sign-in, never extended, and 48 hours
 * of inactivity — are enforced by the database (0022), not by this file.
 */

export const AUTH_BASE_PATH = "/api/auth";
export const SEVEN_DAYS = 7 * 24 * 60 * 60;
export const CODE_MINUTES = 10;

export type SocialProvider = "google" | "microsoft";

/** The providers with credentials configured. Unconfigured ones are not offered. */
export function configuredProviders(): SocialProvider[] {
  const out: SocialProvider[] = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) out.push("google");
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) out.push("microsoft");
  return out;
}

export function loginOrigin(): string {
  return originFor(PRIMARY_HOST);
}

/**
 * Endpoints switched off: the link-based verification and reset flows (codes are used instead — mail
 * scanners follow links), changing the address or deleting the identity (an
 * operator's job while accounts are by invitation), editing the session or
 * profile from the browser, and reading provider tokens.
 */
const DISABLED_PATHS = [
  "/request-password-reset",
  "/reset-password",
  "/reset-password/:token",
  "/send-verification-email",
  "/verify-email",
  "/forget-password/email-otp",
  "/email-otp/check-verification-otp",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  "/update-user",
  "/update-session",
  "/verify-password",
  "/account-info",
  "/get-access-token",
  "/refresh-token",
];

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be set, at least 32 characters.");
  }
  const origin = loginOrigin();
  const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET;
  const microsoft = process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET;

  return betterAuth({
    appName: "10XiD",
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret,
    trustedOrigins: [origin],
    telemetry: { enabled: false },
    database: drizzleAdapter(authDb(), {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        rateLimit: authRateLimits,
      },
    }),
    disabledPaths: DISABLED_PATHS,

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
    },

    socialProviders: {
      ...(google
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID!,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
              prompt: "select_account" as const,
            },
          }
        : {}),
      ...(microsoft
        ? {
            microsoft: {
              clientId: process.env.MICROSOFT_CLIENT_ID!,
              clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
              tenantId: process.env.MICROSOFT_TENANT_ID || "common",
              prompt: "select_account" as const,
              // Microsoft vouches for an address only through the optional
              // `xms_edov` claim (email domain owner verified), which has to
              // be added to the app registration's token configuration. Its
              // `email` claim alone is editable by tenant administrators.
              mapProfileToUser: (profile: Record<string, unknown>) => ({
                emailVerified: profile.xms_edov === true || profile.xms_edov === 1 || profile.xms_edov === "1",
              }),
            },
          }
        : {}),
    },

    account: {
      // Never attach a Google or Microsoft sign-in to an existing identity
      // because the addresses match. Linking is something a signed-in person
      // does, explicitly, after the authenticator.
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: [],
        allowDifferentEmails: false,
      },
      encryptOAuthTokens: true,
    },

    session: {
      expiresIn: SEVEN_DAYS,
      // A refresh is a write, and every write is activity: 0022's trigger sets
      // last_active_at and caps expires_at at created_at + 7 days, and its
      // policy hides a session idle for 48 hours. Refreshing at most once a
      // minute keeps the inactivity clock exact without a write per request.
      updateAge: 60,
      cookieCache: { enabled: false },
      freshAge: 10 * 60,
      additionalFields: {
        mfaVerifiedAt: { type: "date", required: false, input: false },
        lastActiveAt: { type: "date", required: false, input: false },
      },
    },

    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/*": { window: 60, max: 10 },
        "/sign-up/*": { window: 60, max: 5 },
        "/email-otp/*": { window: 60, max: 5 },
      },
    },

    advanced: {
      // Stated, not inherited: Better Auth turns its origin and CSRF checks off
      // by default when it detects a test runner. They are on everywhere.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      cookiePrefix: "10xid",
      useSecureCookies: origin.startsWith("https://"),
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true, path: "/" },
      // Rate limits key on the client's address. Railway's edge sets
      // X-Real-IP and nothing sits in front of it, so that is the one header
      // trusted; X-Forwarded-For's first entry is whatever the client sent.
      ipAddress: {
        ipAddressHeaders: [(process.env.CLIENT_IP_HEADER || "x-real-ip").toLowerCase()],
      },
    },

    databaseHooks: {
      user: {
        create: {
          /**
           * An identity is created only for an address somebody let in — a
           * live invitation, or an existing portal account (which an operator
           * then confirms) — and, when it comes from Google or Microsoft, only
           * if the provider vouches for the address. Otherwise anybody could
           * create an identity for an invited address they do not own, link
           * their own Microsoft account to it, and wait for the real owner to
           * verify the address for them.
           */
          before: async (user, ctx) => {
            const email = normalizeEmail(user.email);
            if (!(await mayCreateSignIn(email))) {
              throw new APIError("FORBIDDEN", {
                message: "This address has not been invited to 10XiD.",
                code: "NOT_INVITED",
              });
            }
            const path = ctx?.path ?? "";
            if (path === "/sign-up/email") {
              return { data: { ...user, email, emailVerified: false } };
            }
            if (path === "/sign-in/email-otp") {
              // The emailed code proved the mailbox.
              return { data: { ...user, email, emailVerified: true } };
            }
            if (path === "/callback/:id" || path === "/sign-in/social") {
              if (!user.emailVerified) {
                throw new APIError("FORBIDDEN", {
                  message:
                    "Your provider did not confirm this address. Sign in with an emailed code first, then link the provider from your account.",
                  code: "PROVIDER_EMAIL_UNVERIFIED",
                });
              }
              return { data: { ...user, email } };
            }
            throw new APIError("FORBIDDEN", { message: "Not allowed.", code: "IDENTITY_CREATION_REFUSED" });
          },
        },
      },
    },

    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: CODE_MINUTES * 60,
        allowedAttempts: 5,
        storeOTP: "hashed",
        overrideDefaultEmailVerification: true,
        sendVerificationOnSignUp: true,
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in" && type !== "email-verification" && type !== "forget-password") return;
          // Codes go only to addresses that may sign in at all; anybody else's
          // request is answered identically and sends nothing.
          if (!(await mayReceiveCodes(email))) return;
          await sendAuthCode({ to: email, code: otp, purpose: type, expiresInMinutes: CODE_MINUTES });
        },
      }),
      mfaGate(),
      nextCookies(),
    ],
  });
}

/**
 * An address an emailed code may be sent to: one an identity may be created
 * for (invited, or an existing portal account), or one whose identity is
 * already bound to a portal account.
 */
async function mayReceiveCodes(emailRaw: string): Promise<boolean> {
  const email = normalizeEmail(emailRaw);
  if (await mayCreateSignIn(email)) return true;
  const [identity] = await authDb()
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, email))
    .limit(1);
  return identity ? (await userByAuthUserId(identity.id)) !== null : false;
}

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | null = null;

/** Built on first use, so `next build` never needs the runtime secrets. */
export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}
