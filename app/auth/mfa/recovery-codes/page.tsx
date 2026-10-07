import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLoginSession, nextQuery, safeNext } from "@/lib/auth/login";
import { readRecoveryCodes } from "@/lib/auth/recovery-codes-once";
import { recoveryCodesSavedAction } from "../../identity-actions";
import { AuthCard, SubmitButton } from "../../auth-card";
import { Hidden } from "../../flow-ui";

export const metadata: Metadata = { title: "Your recovery codes" };

/** Shown once, right after the codes are made (lib/auth/recovery-codes-once.ts). */
export default async function RecoveryCodesPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const session = await getLoginSession();
  if (!session?.mfaVerifiedAt) redirect(`/auth/sign-in${nextQuery(next)}`);
  const codes = await readRecoveryCodes();
  if (!codes) redirect(next === "/" ? "/auth/access" : next);

  return (
    <AuthCard title="Save your recovery codes"
      intro="Each works once, in place of your authenticator — if you lose your phone, they are how you get back in. Keep them somewhere safe, such as a password manager. They will not be shown again.">
      <ul className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-sunk p-3 font-mono text-sm text-ink">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <form action={recoveryCodesSavedAction}>
        <Hidden name="next" value={next} />
        <SubmitButton>I have saved them — continue</SubmitButton>
      </form>
    </AuthCard>
  );
}
