import { NextRequest, NextResponse } from "next/server";
import { userById, redeemTicket, authSessionLive } from "@/lib/db/identity";
import { hashTicket } from "@/lib/auth/sso";
import { constantTimeEquals, waClient } from "@/lib/auth/wa-external";
export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export async function POST(request: NextRequest) {
  const config = waClient(), secret = process.env.WA_EXTERNAL_CLIENT_SECRET;
  const bearer = request.headers.get("authorization") || "";
  if (!config || !secret || secret.length < 32 || !bearer.startsWith("Bearer ") || !constantTimeEquals(secret, bearer.slice(7))) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "";
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(code)) return NextResponse.json({ error: "invalid_grant" }, { status: 400, headers: noStore });
  try {
    const ticket = await redeemTicket(hashTicket(code), config.audience);
    const user = ticket ? await userById(ticket.userId) : null;
    if (!ticket?.sourceAuthSessionId || !user || user.isService || !(await authSessionLive(ticket.sourceAuthSessionId))) return NextResponse.json({ error: "invalid_grant" }, { status: 400, headers: noStore });
    return NextResponse.json({ subject: user.id }, { headers: noStore });
  } catch { return NextResponse.json({ error: "unavailable" }, { status: 503, headers: noStore }); }
}
