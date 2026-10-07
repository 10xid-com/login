import "server-only";
import { appendFile } from "node:fs/promises";

/**
 * Delivery of one-time codes: signing in, verifying an address, resetting a
 * password. Better Auth's email-OTP plugin generates and checks them (stored
 * hashed); this only carries them.
 *
 * In production this goes through Resend. With no API key configured — local
 * development and tests — the code is written to the server log and to a file,
 * so the flow can be exercised end to end without sending real email to real
 * people.
 *
 * The development sink is deliberately a file outside the repository rather
 * than an endpoint the application serves. An endpoint that hands out sign-in
 * codes is a backdoor if it ever survives into production, and "it is only
 * enabled in development" is exactly the sentence that precedes an incident.
 */

const DEV_CODE_SINK =
  process.env.DEV_CODE_SINK ?? "/tmp/portal-signin-codes.log";

export type CodePurpose = "sign-in" | "email-verification" | "forget-password";

const SUBJECT: Record<CodePurpose, (code: string) => string> = {
  "sign-in": (code) => `${code} is your 10XiD sign-in code`,
  "email-verification": (code) => `${code} is your 10XiD verification code`,
  "forget-password": (code) => `${code} is your 10XiD password reset code`,
};

const OPENING: Record<CodePurpose, string> = {
  "sign-in": "Your sign-in code is",
  "email-verification": "Your code to verify this address is",
  "forget-password": "Your code to reset your password is",
};

export async function sendAuthCode(input: {
  to: string;
  code: string;
  purpose: CodePurpose;
  expiresInMinutes: number;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "RESEND_API_KEY is not set, so sign-in codes cannot be delivered. " +
          "Refusing to fall back to writing codes to disk in production.",
      );
    }
    const line = `${new Date().toISOString()}\t${input.to}\t${input.code}\t${input.purpose}\n`;
    await appendFile(DEV_CODE_SINK, line, "utf8");
    console.log(`[dev] ${input.purpose} code for ${input.to}: ${input.code}`);
    return;
  }

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from: process.env.MAIL_FROM ?? "10XiD <no-reply@10xid.com>",
    to: input.to,
    subject: SUBJECT[input.purpose](input.code),
    text: [
      `${OPENING[input.purpose]} ${input.code}.`,
      ``,
      `It expires in ${input.expiresInMinutes} minutes and can be used once.`,
      ``,
      `If you did not ask for this, you can ignore this message — the code`,
      `is useless without access to this mailbox.`,
    ].join("\n"),
  });
  if (error) throw new Error(`Resend refused the message: ${error.name}`);
}

/**
 * The legacy emailed-code sign-in (lib/auth/codes.ts), kept unchanged until
 * that flow is removed. The Better Auth flow uses sendAuthCode above.
 */
export async function sendSignInCode(input: {
  to: string;
  code: string;
  expiresInMinutes: number;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "RESEND_API_KEY is not set, so sign-in codes cannot be delivered. " +
          "Refusing to fall back to writing codes to disk in production.",
      );
    }
    const line = `${new Date().toISOString()}\t${input.to}\t${input.code}\n`;
    await appendFile(DEV_CODE_SINK, line, "utf8");
    console.log(`[dev] sign-in code for ${input.to}: ${input.code}`);
    return;
  }

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  await resend.emails.send({
    from: process.env.MAIL_FROM ?? "10XiD <no-reply@10xid.com>",
    to: input.to,
    subject: `${input.code} is your sign-in code`,
    text: [
      `Your sign-in code is ${input.code}.`,
      ``,
      `It expires in ${input.expiresInMinutes} minutes and can be used once.`,
      ``,
      `If you did not ask to sign in, you can ignore this message — the code`,
      `is useless without access to this mailbox.`,
    ].join("\n"),
  });
}

/**
 * Tell somebody they have been invited.
 *
 * Carries no credential. The invitation lives in the database against this
 * address, and the sign-up screen checks it there — so this message being
 * forwarded, quoted or leaked hands nobody an account. What proves the person
 * is who the invitation names is the six-digit code that follows, which only
 * reaches this mailbox.
 */
export async function sendInvitation(input: {
  to: string;
  organizationName: string;
  invitedByEmail: string;
  signUpUrl: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  const body = [
    `${input.invitedByEmail} has invited you to the 10XiD portal for ${input.organizationName}.`,
    ``,
    `To set up your account, go to:`,
    `  ${input.signUpUrl}`,
    ``,
    `Use this address. You can choose a password, ask for an emailed code, or`,
    `continue with Google or Microsoft if this address is your work account.`,
    `Whichever you choose, you will also set up an authenticator app: 10XiD asks`,
    `for a code from it every time you sign in.`,
    ``,
    `If you were not expecting this, you can ignore it. The invitation grants`,
    `nothing on its own and lapses on its own.`,
  ].join("\n");

  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "RESEND_API_KEY is not set, so invitations cannot be delivered. " +
          "Refusing to fall back to writing them to disk in production.",
      );
    }
    await appendFile(
      DEV_CODE_SINK,
      `${new Date().toISOString()}\t${input.to}\tINVITED\t${input.organizationName}\n`,
      "utf8",
    );
    console.log(`[dev] invitation for ${input.to} → ${input.organizationName}`);
    return;
  }

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  await resend.emails.send({
    from: process.env.MAIL_FROM ?? "10XiD <no-reply@10xid.com>",
    to: input.to,
    subject: `You have been invited to the 10XiD portal`,
    text: body,
  });
}
