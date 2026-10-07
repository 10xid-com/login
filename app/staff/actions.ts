"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  createStaffGrant,
  endGrantsForSession,
  organizationById,
  setSessionActiveOrganization,
} from "@/lib/db/identity";
import { getSessionContext } from "@/lib/auth/session";
import { refuseWhileActingAs } from "@/lib/auth/require";
import { STAFF_GRANT_SECONDS } from "@/lib/auth/policy";
import { signInUrl } from "@/lib/auth/sso";

/**
 * Staff do not get ambient access to every client.
 *
 * They exchange their identity for a time-boxed grant to ONE client, carrying a
 * reason typed at the moment of switching. This is the same shape as AWS
 * AssumeRole or Shopify's "log in to store": you do not hold cross-account
 * power, you trade for a narrow, logged, expiring credential.
 *
 * The payoff is that every query in the application reads identically for staff
 * and clients — there is no second, less-travelled code path where the bugs
 * live — and the audit line says which client was opened and why, rather than
 * merely that an admin was active.
 */

/**
 * Where to go once a client is opened. An allowlist, never a URL from the
 * form: the workspace opens clients too, and wants to land back on itself.
 */
const RETURN_TO = { jobs: "/jobs", chat: "/chat" } as const;

const chooseSchema = z.object({
  organizationId: z.uuid(),
  reason: z.string().trim().min(8).max(200),
});

export async function chooseClientAction(formData: FormData) {
  const ctx = await getSessionContext();
  if (!ctx) redirect(signInUrl());

  /**
   * Not while being somebody else.
   *
   * `staff_grants` has ONE identity column, `staff_user_id`. A grant written
   * from inside an act-as session would name the person being appeared as, and
   * the audit line that exists to say "Paolo opened Rotary at 14:02 because —"
   * would say Joel did. There is nowhere in that row to put the truth, so the
   * answer is not to write it: opening a client waits until you are yourself.
   * `job_events` took the other route and gained columns for both people; this
   * table has not, and quietly misfiling one is worse than a refusal.
   */
  refuseWhileActingAs(ctx);

  // Staff-ness comes from the session, which took it from the account record.
  // It is never read from the form, so tampering with the form achieves nothing.
  if (!ctx.scope.isStaff) redirect("/jobs");

  const parsed = chooseSchema.safeParse({
    organizationId: formData.get("organizationId"),
    reason: formData.get("reason"),
  });

  const returnTo = RETURN_TO[formData.get("returnTo") === "chat" ? "chat" : "jobs"];
  const back = returnTo === "/chat" ? "/chat" : "/staff";

  if (!parsed.success) {
    redirect(`${back}?error=reason`);
  }

  const org = await organizationById(parsed.data.organizationId);
  if (!org || org.type !== "client") redirect(`${back}?error=unknown`);

  await createStaffGrant({
    staffUserId: ctx.userId,
    organizationId: org.id,
    reason: parsed.data.reason,
    sessionId: ctx.sessionId,
    expiresAt: new Date(Date.now() + STAFF_GRANT_SECONDS * 1000),
  });

  await setSessionActiveOrganization(ctx.sessionId, org.id);

  revalidatePath("/", "layout");
  redirect(returnTo);
}

export async function exitClientAction(formData?: FormData) {
  const ctx = await getSessionContext();
  if (!ctx) redirect(signInUrl());
  // Nor may somebody else give up a grant that is not theirs.
  refuseWhileActingAs(ctx);

  // The grant row is kept — it is the audit record of what was opened and why —
  // but its window is closed now. Clearing the session pointer alone would not
  // end the access, because the scope is derived from the live grant.
  await endGrantsForSession(ctx.sessionId);
  await setSessionActiveOrganization(ctx.sessionId, null);

  revalidatePath("/", "layout");
  redirect(formData?.get("returnTo") === "chat" ? "/chat" : "/staff");
}
