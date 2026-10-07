"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth/session";
import { startActingAs, stopActingAs } from "@/lib/auth/act-as";
import { GRANT_REASON_MAX, GRANT_REASON_MIN } from "@/lib/auth/policy";
import { signInUrl } from "@/lib/auth/sso";

/**
 * The two buttons. Everything they mean lives in lib/auth/act-as.ts.
 *
 * This file turns a form into arguments and a refusal into a query string, and
 * holds no rule of its own — deliberately, because a rule that lives in a
 * server action can only be exercised by clicking, and the ones that matter
 * here need to be exercised by the test suite.
 */

const startSchema = z.object({
  targetUserId: z.uuid(),
  reason: z.string().trim().min(GRANT_REASON_MIN).max(GRANT_REASON_MAX),
});

export async function startActingAsAction(formData: FormData) {
  const ctx = await getSessionContext();
  if (!ctx) redirect(signInUrl());

  const parsed = startSchema.safeParse({
    targetUserId: formData.get("targetUserId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) redirect("/act-as?error=reason");

  const result = await startActingAs({
    sessionId: ctx.sessionId,
    // Every one of these is the REAL person. While acting as a client the
    // session's own scope is not staff, so a check written against it would
    // hand a staff session a way to shed its rules by putting on a coat.
    realUserId: ctx.realUserId,
    realIsStaff: ctx.realIsStaff,
    needsSecondFactor: ctx.needsSecondFactor,
    actingAsUserId: ctx.actingAs?.userId ?? null,
    targetUserId: parsed.data.targetUserId,
    reason: parsed.data.reason,
  });

  if (!result.ok) redirect(`/act-as?error=${result.refusal}`);

  // The whole shell changes — the banner, the nav, whose rows are on screen —
  // so the layout is revalidated rather than one route.
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function stopActingAsAction() {
  const ctx = await getSessionContext();
  if (!ctx) redirect(signInUrl());

  // No check beyond having a session: stopping is always allowed, and a
  // confirmation step on the way OUT of somebody else's account would be a
  // step in the wrong direction.
  await stopActingAs(ctx.sessionId);

  revalidatePath("/", "layout");
  redirect("/act-as?done=stopped");
}
