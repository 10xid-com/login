"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth/session";
import { attachDriveFolder, getJob, listJobEvents } from "@/lib/db";
import { createJobFolder, driveIsConfigured, uploadToFolder } from "@/lib/integrations/google-drive";
import { signInUrl } from "@/lib/auth/sso";

/**
 * Give a request a folder in Google Drive, and put the request in it.
 *
 * Two things happen and only the first is allowed to fail loudly. Creating the
 * folder is the point; writing the summary into it is a convenience, and an
 * empty folder recorded against the job beats a folder that exists in Drive
 * while the portal thinks it does not — which is what rolling back would leave.
 */

export async function createDriveFolderAction(formData: FormData) {
  const ctx = await getSessionContext();
  if (!ctx) redirect(signInUrl());
  if (ctx.needsSecondFactor) redirect("/auth/2fa");

  const jobId = z.uuid().safeParse(formData.get("jobId"));
  if (!jobId.success) redirect("/dashboard?error=unknown");

  // Staff surveying every client have no company to write into. They choose
  // one first, which records which and why.
  if (!ctx.scope.organizationId) redirect("/staff?error=choose");
  if (!driveIsConfigured()) redirect("/dashboard?error=drive_unconfigured");

  // Through the scoped helper, so a job id belonging to another client is
  // simply not found — the same answer as an id that never existed.
  const job = await getJob(ctx.scope, jobId.data);
  if (!job) redirect("/dashboard?error=unknown");
  if (job.driveFolderId) redirect("/dashboard?done=already");

  let folder;
  try {
    folder = await createJobFolder(`${job.ref} — ${job.title}`);
  } catch (cause) {
    // The shape of the failure, never a credential.
    console.error(
      "[drive] could not create a folder:",
      cause instanceof Error ? cause.message : cause,
    );
    redirect("/dashboard?error=drive_failed");
  }

  const attached = await attachDriveFolder(ctx.scope, jobId.data, folder);
  if (!attached) redirect("/dashboard?done=already");

  // Put the request itself in the folder, so opening it shows the enquiry
  // rather than an empty space waiting for somebody to paste it in.
  try {
    const events = await listJobEvents(ctx.scope, jobId.data);
    await uploadToFolder({
      folderId: folder.id,
      name: `${job.ref} — request.txt`,
      mimeType: "text/plain",
      content: summarise(job, events),
    });
  } catch (cause) {
    console.error(
      "[drive] the folder was created but the summary did not upload:",
      cause instanceof Error ? cause.message : cause,
    );
    revalidatePath("/dashboard");
    redirect("/dashboard?error=drive_partial");
  }

  revalidatePath("/dashboard");
  redirect("/dashboard?done=filed");
}

/**
 * The request as plain text.
 *
 * Deliberately not a document format: a .txt file opens in every tool anybody
 * has, survives being copied anywhere, and cannot carry a macro. What a
 * stranger typed into a public form goes in verbatim, as text, and is never
 * interpreted as anything else.
 */
function summarise(
  job: { ref: string; title: string; status: string; createdAt: Date },
  events: Array<{ action: string; after: unknown }>,
): string {
  const created = events.find((e) => e.action === "created");
  const details =
    created && typeof created.after === "object" && created.after !== null
      ? ((created.after as Record<string, unknown>).details as
          | Record<string, unknown>
          | undefined)
      : undefined;

  const lines = [
    job.ref,
    job.title,
    "",
    `Status:   ${job.status.replace(/_/g, " ")}`,
    `Received: ${new Date(job.createdAt).toISOString().replace("T", " ").slice(0, 19)} UTC`,
  ];

  if (details) {
    lines.push("", "Submitted details", "-----------------");
    for (const [key, value] of Object.entries(details)) {
      if (typeof value !== "string" || value.length === 0) continue;
      lines.push(`${key.replace(/_/g, " ")}: ${value}`);
    }
  }

  lines.push(
    "",
    "---",
    "Filed from the 10XiD portal. This file is a snapshot of the request as it",
    "arrived; the portal holds the authoritative record.",
  );

  return lines.join("\n");
}
