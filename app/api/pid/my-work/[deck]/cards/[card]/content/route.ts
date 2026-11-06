import { failureStatus, loadCardContent, safeJsonHeaders } from "@/lib/pid/my-work";
import { myWorkActor } from "@/lib/pid/my-work-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ deck: string; card: string }> }) {
  const actor = await myWorkActor();
  if (actor.state === "signed_out" || actor.state === "needs_mfa") {
    return Response.json({ error: "Sign in required" }, { status: 401, headers: safeJsonHeaders() });
  }
  if (actor.state === "no_account") return Response.json({ error: "Not found" }, { status: 404, headers: safeJsonHeaders() });
  const { deck, card } = await params;
  const result = await loadCardContent(actor.actorId, deck.toLowerCase(), card);
  if (!result.ok) {
    return Response.json({ error: result.reason === "unavailable" ? "Unavailable" : "Not found" }, { status: failureStatus(result.reason), headers: safeJsonHeaders() });
  }
  return Response.json(result.value, { headers: safeJsonHeaders() });
}
