import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getLoginSession } from "@/lib/auth/login";
import { open, freshMfa } from "@/lib/wrapauthority/protocol";
import { waClient } from "@/lib/auth/wa-external";
export const dynamic = "force-dynamic";
export default async function ConfirmWrapAuthorityLink() {
  const config = waClient(), secret = process.env.WA_EXTERNAL_CLIENT_SECRET || "";
  const session = await getLoginSession();
  const challenge = (await cookies()).get("__Host-wa_consent")?.value || "";
  const consent = open(challenge, secret, "wa-consent");
  if (!config || !session || !consent || consent.session !== session.sessionId) redirect("/auth/account");
  const needsCode = !freshMfa(session.mfaVerifiedAt);
  return <main className="mx-auto max-w-lg space-y-5 px-6 py-16">
    <h1 className="text-2xl font-semibold">Link your Wrap Authority account</h1>
    <p>Signed in as {session.user.email}. Link this 10XiD identity to the Wrap Authority account where you started.</p>
    <p>This lets your 10XiD account show your outline purchases. Artwork stays with Wrap Authority.</p>
    <form action="/auth/wa/authorize" method="post" className="space-y-4">
      <input type="hidden" name="challenge" value={challenge} />
      {needsCode && <label className="block">Current authenticator code
        <input name="code" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" maxLength={6} required className="block rounded border p-3" />
      </label>}
      <label className="block"><input type="checkbox" name="consent" value="yes" required /> I approve linking these accounts.</label>
      <button type="submit" className="rounded border px-5 py-3">Link accounts</button>
    </form>
    <a href={config.waOrigin + "/wrapauthority/my-outlines"}>Cancel</a>
  </main>;
}
