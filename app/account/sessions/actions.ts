"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  revokeOtherSessionsForUser,
  revokeOwnSession,
} from "@/lib/db/identity";
import { requireOwnAccount } from "@/lib/auth/require";
import { getSessionContext } from "@/lib/auth/session";
import { signInUrl } from "@/lib/auth/sso";

/**
 * Revoking is scoped to the signed-in person by the query itself — the session
 * id in the form is matched against their own user id in the same statement.
 * Someone submitting a stranger's session id revokes nothing. What is revoked
 * is the DEVICE that session is on (lib/db/identity.ts, revokeOwnSession).
 */
export async function revokeSessionAction(formData: FormData) {
  // requireOwnAccount, not requireSession: ending somebody's other sessions
  // is their account's own business, and it outlives the hour.
  const ctx = await requireOwnAccount("/account/sessions");

  const parsed = z.uuid().safeParse(formData.get("sessionId"));
  if (!parsed.success) redirect("/account/sessions");

  await revokeOwnSession(ctx.userId, parsed.data);

  // Signing out a device ends every session on it, so whether this one went
  // too is read back rather than guessed from the id that was posted.
  if (!(await getSessionContext())) redirect(signInUrl());

  revalidatePath("/account/sessions");
  redirect("/account/sessions?done=one");
}

export async function revokeOthersAction() {
  const ctx = await requireOwnAccount("/account/sessions");
  await revokeOtherSessionsForUser(ctx.userId, ctx.sessionId);

  revalidatePath("/account/sessions");
  redirect("/account/sessions?done=others");
}
