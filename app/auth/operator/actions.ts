"use server";

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { getAuth } from "@/lib/auth/auth";
import { assertLoginOrigin } from "@/lib/auth/login";
import { allow } from "@/lib/auth/throttle";
import {
  INVITE_ROLES,
  decideBinding,
  endAccess,
  getOperator,
  invite,
  isFresh,
  logOperator,
  type Operator,
} from "@/lib/auth/operator";

/**
 * The operator screen's actions. Each one: the request came from this host's
 * own page; the caller is an operator (otherwise 404, as for the page); and
 * the authenticator was passed within five minutes — or a code from it comes
 * with this very request, checked with the same lockout and replay rules as
 * signing in.
 */

function back(params: Record<string, string>): never {
  redirect(`/auth/operator?${new URLSearchParams(params).toString()}`);
}

async function operatorWithStepUp(form: FormData): Promise<Operator> {
  await assertLoginOrigin();
  const op = await getOperator();
  if (!op) notFound();
  if (isFresh(op)) return op;
  const code = z.string().trim().regex(/^\d{6}$/).safeParse(form.get("code"));
  if (!code.success) back({ error: "code" });
  if (!(await allow("mfa", op.session.user.id))) back({ error: "rate" });
  try {
    await getAuth().api.mfaVerify({ body: { code: code.data }, headers: await headers() });
  } catch (error) {
    if (error instanceof APIError) {
      const c = (error.body as { code?: string } | undefined)?.code;
      back({ error: c === "MFA_LOCKED" ? "locked" : "code" });
    }
    throw error;
  }
  return op;
}

const uuid = z.string().uuid();
const email = z.string().trim().toLowerCase().email().max(320);

export async function decideBindingAction(form: FormData) {
  const op = await operatorWithStepUp(form);
  const id = uuid.safeParse(form.get("request"));
  const decision = form.get("decision");
  if (!id.success || (decision !== "confirm" && decision !== "reject")) back({ error: "invalid" });
  const outcome = await decideBinding(id.data, decision === "confirm", op.name);
  logOperator(op, `binding.${decision}`, id.data, outcome);
  if (outcome === "confirmed" || outcome === "rejected") back({ notice: outcome });
  back({ error: outcome });
}

export async function inviteAction(form: FormData) {
  const op = await operatorWithStepUp(form);
  const address = email.safeParse(form.get("email"));
  const business = uuid.safeParse(form.get("business"));
  const role = z.enum(INVITE_ROLES).safeParse(form.get("role"));
  if (!address.success || !business.success || !role.success) back({ error: "invalid" });
  try {
    await invite(address.data, business.data, role.data, op.accountId);
  } catch {
    logOperator(op, "invite", address.data, "refused");
    back({ error: "invite" });
  }
  logOperator(op, "invite", `${address.data} → ${business.data} as ${role.data}`, "invited");
  back({ notice: "invited", who: address.data });
}

export async function endAccessAction(form: FormData) {
  const op = await operatorWithStepUp(form);
  const address = email.safeParse(form.get("email"));
  const what = form.get("what");
  if (!address.success || (what !== "reset" && what !== "sign-out")) back({ error: "invalid" });
  const outcome = await endAccess(address.data, { resetAuthenticator: what === "reset" });
  logOperator(op, what === "reset" ? "reset-authenticator" : "sign-out-everywhere", address.data, outcome);
  if (outcome === "no_identity") back({ error: "no_identity" });
  back({ notice: what === "reset" ? "reset" : "signed-out", who: address.data });
}
