import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { afterSignIn } from "@/lib/auth/sso";
import { getSessionContext } from "@/lib/auth/session";
import { refuseWhileActingAs } from "@/lib/auth/require";
import { userById } from "@/lib/db/identity";
import { decryptSecret, otpauthUri, secondFactorConfigured } from "@/lib/auth/totp";
import {
  AuthCard,
  FieldError,
  SubmitButton,
  inputClass,
  labelClass,
} from "../auth-card";
import { beginEnrolmentAction, verifySecondFactorAction } from "./actions";

export const metadata: Metadata = { title: "Second step" };

const ERRORS: Record<string, string> = {
  wrong: "That code did not work. Codes change every 30 seconds — try the current one.",
  format: "Enter the six digits from your authenticator app.",
  notset: "No authenticator is set up for this account yet.",
  already: "An authenticator is already set up. Ask another staff member to reset it.",
};

/**
 * The second step, for staff only.
 *
 * A client never sees this. Staff do, because a staff session reaches every
 * client's data, and the first factor is an emailed code — which means one
 * compromised inbox would otherwise reach every client at once.
 */
export default async function SecondFactorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/auth/login");
  refuseWhileActingAs(ctx);
  if (ctx.role !== "staff") redirect(afterSignIn("/jobs"));
  if (!ctx.needsSecondFactor) redirect(afterSignIn("/jobs"));

  const params = await searchParams;
  const error = params.error ? ERRORS[params.error] : null;
  const next = params.next ?? "/jobs";

  if (!secondFactorConfigured()) {
    return (
      <AuthCard
        title="Second step unavailable"
        intro="This deployment has no encryption key configured for authenticator secrets, so enrolment is refused rather than storing them unprotected."
      >
        <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-ink-soft">
          Set <code className="font-mono text-xs">TOTP_ENC_KEY</code> to a
          base64-encoded 32-byte key and restart.
        </p>
      </AuthCard>
    );
  }

  const user = await userById(ctx.userId);
  const enrolling = !user?.totpConfirmedAt;
  const secret = user?.totpSecret ? decryptSecret(user.totpSecret) : null;

  // No secret issued yet: offer to start, rather than minting one on a GET.
  if (enrolling && !secret) {
    return (
      <AuthCard
        title="Set up your authenticator"
        intro="Staff accounts need a second step because a staff session can reach every client's data."
      >
        <form action={beginEnrolmentAction}>
          <input type="hidden" name="next" value={next} />
          <SubmitButton>Start setup</SubmitButton>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={enrolling ? "Set up your authenticator" : "Second step"}
      intro={
        enrolling
          ? "Add this to an authenticator app, then enter the six digits it shows."
          : "Enter the six digits from your authenticator app."
      }
      footer={
        enrolling
          ? "Any authenticator app works — 1Password, Authy, Google Authenticator."
          : "Codes change every 30 seconds."
      }
    >
      {enrolling && secret ? (
        <div className="mb-5 rounded-lg border border-line bg-sunk p-3">
          <p className={labelClass}>Setup key</p>
          <p className="break-all font-mono text-sm text-ink select-all">
            {secret.match(/.{1,4}/g)?.join(" ")}
          </p>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-ink-faint">
              Or paste this link into your app
            </summary>
            <p className="mt-2 break-all font-mono text-[11px] text-ink-faint select-all">
              {otpauthUri(secret, ctx.email)}
            </p>
          </details>
        </div>
      ) : null}

      <form action={verifySecondFactorAction}>
        <input type="hidden" name="next" value={next} />
        <label htmlFor="code" className={labelClass}>
          Six-digit code
        </label>
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          placeholder="000000"
          className={`${inputClass} text-center text-lg tracking-[0.4em] tabular-nums`}
        />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>{enrolling ? "Confirm and continue" : "Continue"}</SubmitButton>
      </form>
    </AuthCard>
  );
}
