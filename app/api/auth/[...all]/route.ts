import { getAuth } from "@/lib/auth/auth";

/**
 * Better Auth's endpoints, at /api/auth/* on the login host only. The handler
 * is built on the first request, so the build never needs the runtime secrets.
 */
export function GET(request: Request) {
  return getAuth().handler(request);
}

export function POST(request: Request) {
  return getAuth().handler(request);
}
