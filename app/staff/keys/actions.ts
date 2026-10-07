"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth/session";
import { refuseWhileActingAs } from "@/lib/auth/require";
import { mintKey, revokeKey } from "@/lib/db/api-keys";
import { signInUrl } from "@/lib/auth/sso";

/**
 * Minting and revoking keys.
 *
 * Both are writes, so both need a session scoped to ONE client — which for
 * staff means holding a live grant with a reason attached. That falls out of
 * the existing rule rather than being restated here: `scope.organizationId` is
 * null while staff are surveying, and every write path refuses a null.
 */

const mintSchema = z.object({
  label: z.string().trim().min(3).max(80),
});

export async function mintKeyAction(formData: FormData) {
  const ctx = await getSessionContext();
  if (!ctx) redirect(signInUrl());
  // A key is a credential with no expiry of its own, and `created_by` is one
  // column. Unreachable from an act-as session anyway — acting as a client is
  // not staff, and acting as staff holds no client — but said out loud, because
  // relying on two other checks to add up to this one is how it stops being true.
  refuseWhileActingAs(ctx);
  if (!ctx.scope.isStaff) redirect("/jobs");

  // Staff surveying every client have no single company to mint into. They
  // choose one first, which writes the grant that says which and why.
  if (!ctx.scope.organizationId) redirect("/staff?error=choose");

  const parsed = mintSchema.safeParse({ label: formData.get("label") });
  if (!parsed.success) redirect("/staff/keys?error=label");

  const minted = await mintKey({
    organizationId: ctx.scope.organizationId,
    label: parsed.data.label,
    createdBy: ctx.userId,
  });

  revalidatePath("/staff/keys");

  // The key travels back in the URL because this is the only moment it exists
  // in readable form — it is stored as a hash and cannot be shown again. That
  // does put it in the browser's history, which is why the screen says to
  // revoke and re-mint if it was not copied somewhere safe immediately.
  redirect(`/staff/keys?minted=${encodeURIComponent(minted.secret)}`);
}

export async function revokeKeyAction(formData: FormData) {
  const ctx = await getSessionContext();
  if (!ctx) redirect(signInUrl());
  refuseWhileActingAs(ctx);
  if (!ctx.scope.isStaff) redirect("/jobs");
  if (!ctx.scope.organizationId) redirect("/staff?error=choose");

  const keyId = z.uuid().safeParse(formData.get("keyId"));
  if (!keyId.success) redirect("/staff/keys?error=unknown");

  // The organization comes from the session, not the form, so this cannot be
  // pointed at another client's key by editing the page. Underneath, the tenant
  // policy would refuse the update anyway.
  await revokeKey(ctx.scope.organizationId, keyId.data);

  revalidatePath("/staff/keys");
  redirect("/staff/keys?revoked=1");
}
