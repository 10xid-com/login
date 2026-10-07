import type { Metadata } from "next";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { base32 } from "@better-auth/utils/base32";
import { authenticatorState, getLoginSession, nextQuery, safeNext } from "@/lib/auth/login";
import { otpauthUri } from "@/lib/auth/mfa-gate";
import { confirmEnrollmentAction, startEnrollmentAction } from "../../identity-actions";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../../auth-card";
import { Hidden } from "../../flow-ui";

export const metadata: Metadata = { title: "Set up your authenticator" };

/**
 * Required for everybody, whichever way they sign in. Reading this page
 * changes nothing; "Begin" makes the secret (a POST), and the first code from
 * the app confirms it.
 */
export default async function MfaSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const session = await getLoginSession();
  if (!session) redirect(`/auth/sign-in${nextQuery(next)}`);
  if (!session.user.emailVerified) redirect(`/auth/access${nextQuery(next)}`);
  const factor = await authenticatorState(session.user.id);
  if (factor.state === "enrolled") redirect(`/auth/mfa${nextQuery(next)}`);

  if (factor.state === "none") {
    return (
      <AuthCard title="Set up your authenticator"
        intro="10XiD asks for a code from an authenticator app every time you sign in. Install one (1Password, Google Authenticator, Microsoft Authenticator, Authy…) and continue.">
        <form action={startEnrollmentAction}>
          <Hidden name="next" value={next} />
          <SubmitButton>Begin</SubmitButton>
        </form>
      </AuthCard>
    );
  }

  const uri = otpauthUri(factor.secret, session.user.email);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  const manual = base32.encode(factor.secret, { padding: false }).replace(/(.{4})/g, "$1 ").trim();
  return (
    <AuthCard title="Scan this code" intro="Scan it with your authenticator app, then enter the six-digit code it shows.">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qr} alt="QR code for your authenticator app" width={220} height={220} className="mx-auto rounded-lg border border-line" />
      <p className="mt-3 text-center text-xs text-ink-faint">Can&apos;t scan? Enter this key:</p>
      <p className="mt-1 text-center font-mono text-sm break-all text-ink">{manual}</p>
      <form action={confirmEnrollmentAction} className="mt-6">
        <Hidden name="next" value={next} />
        <label htmlFor="code" className={labelClass}>Code</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}"
          maxLength={6} required className={inputClass} />
        {params.error ? (
          <FieldError>
            {params.error === "code" ? "That code is not right. Use the current code from your app." : "That did not work. Start again."}
          </FieldError>
        ) : null}
        <SubmitButton>Confirm</SubmitButton>
      </form>
    </AuthCard>
  );
}
