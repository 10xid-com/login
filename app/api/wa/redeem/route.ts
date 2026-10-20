import { NextRequest, NextResponse } from "next/server";
import { userById, redeemTicket, authSessionLive } from "@/lib/db/identity";
import { hashTicket } from "@/lib/auth/sso";
import { constantTimeEquals, WA_AUDIENCE } from "@/lib/auth/wa-external";
const noStore = {"Cache-Control":"no-store"};
export async function POST(request: NextRequest) {
  const secret = process.env.WA_EXTERNAL_CLIENT_SECRET;
  const bearer = request.headers.get("authorization") ?? "";
  if (!secret || secret.length < 32 || !bearer.startsWith("Bearer ") ||
      !constantTimeEquals(secret, bearer.slice(7))) {
    return NextResponse.json({error:"unauthorized"}, {status:401,headers:noStore});
  }
  const body = await request.json().catch(() => null);
  const code = body && typeof body.code === "string" ? body.code : "";
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(code)) {
    return NextResponse.json({error:"invalid_grant"}, {status:400,headers:noStore});
  }
  const ticket = await redeemTicket(hashTicket(code), WA_AUDIENCE);
  const user = ticket ? await userById(ticket.userId) : null;
  if (!ticket?.sourceAuthSessionId || !user || user.isService ||
      !(await authSessionLive(ticket.sourceAuthSessionId))) {
    return NextResponse.json({error:"invalid_grant"}, {status:400,headers:noStore});
  }
  return NextResponse.json({subject:user.id}, {headers:noStore});
}
