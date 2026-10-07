"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth/session";
import { refuseWhileActingAs } from "@/lib/auth/require";
import { sendInvitation } from "@/lib/auth/mailer";
import { originFor, PRIMARY_HOST, signInUrl } from "@/lib/auth/sso";
import {
  inviteToOrganization,
  revokeInvitation,
} from "@/lib/db/invitations";
import { organizationById } from "@/lib/db/identity";

/**
 * Inviting somebody.
 *
 * Two rules, both of which fall out of the design rather than being restated
 * here:
 *
 *   * The company comes from the SESSION — `scope.organizationId` — never from
 *     the form. Staff must hold a grant to a client first, which is what makes
 *     "which company is this invitation for" a question with one answer.
 *   * Only an owner of that company, or staff, may do it. A member being able
 *     to invite would mean one compromised account quietly becomes several.
 */

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(["owner", "member"]),
});

async function requireInviter() {
  const ctx = await getSessionContext();
  if (!ctx) redirect(signInUrl());
  if (ctx.needsSecondFactor) redirect("/auth/2fa");
  // `invitations.invited_by` is a single column too, and an invitation creates
  // ACCESS that outlives the hour. Same reasoning as staff grants: refused
  // rather than filed under the wrong name.
  refuseWhileActingAs(ctx);

  const organizationId = ctx.scope.organizationId;
  if (!organizationId) {
    // Staff surveying every client have no single company to invite into. They
    // choose one first, which writes the grant that records which and why.
    redirect("/staff?error=choose");
  }

  const membership = ctx.memberships.find(
    (m) => m.organizationId === organizationId,
  );
  const mayInvite = ctx.scope.isStaff || membership?.role === "owner";
  if (!mayInvite) redirect("/team?error=notowner");

  return { ctx, organizationId };
}

export async function inviteAction(formData: FormData) {
  const { ctx, organizationId } = await requireInviter();

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) redirect("/team?error=email");

  await inviteToOrganization({
    organizationId,
    email: parsed.data.email,
    role: parsed.data.role,
    invitedBy: ctx.userId,
  });

  const org = await organizationById(organizationId);

  /**
   * The invitation email is sent AFTER the row exists, and its failure is not
   * allowed to undo the invitation.
   *
   * The row is what grants anything; the message only tells somebody it is
   * there. If delivery fails, the invitation is still valid and can be pointed
   * at by hand — the alternative, rolling it back, would mean a transient mail
   * outage silently discards work somebody just did.
   */
  try {
    await sendInvitation({
      to: parsed.data.email,
      organizationName: org?.name ?? "your company",
      invitedByEmail: ctx.email,
      // Signing up is signing in, which happens on the login host — not
      // necessarily the host this invitation was sent from.
      signUpUrl: `${originFor(PRIMARY_HOST || ((await headers()).get("host") ?? ""))}/auth/signup`,
    });
  } catch (cause) {
    // The shape of the failure, never the payload or any credential.
    console.error(
      "[invite] the invitation was created but the email did not send:",
      cause instanceof Error ? cause.message : cause,
    );
    revalidatePath("/team");
    redirect("/team?error=mail");
  }

  revalidatePath("/team");
  redirect("/team?done=invited");
}

export async function revokeInvitationAction(formData: FormData) {
  const { organizationId } = await requireInviter();

  const id = z.uuid().safeParse(formData.get("invitationId"));
  if (!id.success) redirect("/team?error=unknown");

  // The company comes from the session, so this cannot be pointed at another
  // company's invitation by editing the page. The tenant policy refuses it
  // underneath in any case.
  await revokeInvitation(organizationId, id.data);

  revalidatePath("/team");
  redirect("/team?done=revoked");
}
