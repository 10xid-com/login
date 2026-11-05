import { getLoginSession } from '@/lib/auth/login';
import { userByAuthUserId } from '@/lib/db/accounts';
import { editableCid, saveCid } from '@/lib/db/cid-profiles';
import { CID_ACTIONS, DEFAULT_CID_ACTIONS, PROFILE_LIMITS, cidUrl, isCidSlug } from '@/lib/cid/profile';
import { MemberError } from '@/lib/uid/member-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const headers: Record<string, string> = {
    'cache-control': 'private, no-store', 'vary': 'Origin', 'x-content-type-options': 'nosniff'
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
  if (!isCidSlug(slug)) return json({ error: 'Company not found.' }, 404);
  const origin = new URL(cidUrl(slug)).origin;
  if (request.headers.get('origin') !== origin) return json({ error: 'Use this company’s CiD.' }, 403);
  headers['access-control-allow-origin'] = origin;
  headers['access-control-allow-credentials'] = 'true';
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      ...headers, 'access-control-allow-methods': 'GET, PUT, OPTIONS', 'access-control-allow-headers': 'Content-Type'
    } });
  }
  try {
    const session = await getLoginSession();
    if (!session?.mfaVerifiedAt) return json({ error: 'Sign in to 10XiD to edit this company.' }, 401);
    const account = await userByAuthUserId(session.user.id);
    if (!account) return json({ error: 'Company editing access is required.' }, 403);
    if (request.method === 'GET') {
      const data = await editableCid(slug, account.id);
      return json({ ...data, fields: PROFILE_LIMITS, actionOptions: CID_ACTIONS, defaultActions: DEFAULT_CID_ACTIONS });
    }
    const length = Number(request.headers.get('content-length'));
    if (length > 16384) return json({ error: 'The profile is too large.' }, 413);
    const input = await request.json().catch(() => null);
    if (!input || !Number.isSafeInteger(input.version)) return json({ error: 'Reload the editor and try again.' }, 422);
    return json(await saveCid(slug, account.id, input.profile, input.version));
  } catch (error) {
    if (error instanceof MemberError) return json({ error: error.message }, error.status);
    return json({ error: 'The profile is temporarily unavailable. Try again.' }, 503);
  }
}

export { handle as GET, handle as PUT, handle as OPTIONS };
