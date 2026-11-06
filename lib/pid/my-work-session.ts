import "server-only";
import { getLoginSession } from "@/lib/auth/login";
import { userByAuthUserId } from "@/lib/db/accounts";

export type MyWorkActor =
  | { state: "signed_out" }
  | { state: "needs_mfa" }
  | { state: "no_account" }
  | { state: "ok"; actorId: string };

/**
 * The one person this request is: the live Login session, past the authenticator, and the portal
 * account bound to it. Linked sign-ins or sibling accounts are never merged in.
 */
export async function myWorkActor(): Promise<MyWorkActor> {
  const session = await getLoginSession();
  if (!session) return { state: "signed_out" };
  if (!session.mfaVerifiedAt) return { state: "needs_mfa" };
  const account = await userByAuthUserId(session.user.id);
  return account ? { state: "ok", actorId: String(account.id).toLowerCase() } : { state: "no_account" };
}
