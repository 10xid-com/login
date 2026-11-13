import {getLoginSession} from '@/lib/auth/login';
import {userByAuthUserId} from '@/lib/db/accounts';
import {CID_COMPANIES,cidUrl,isCidSlug} from '@/lib/cid/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const upstream = 'https://uid-bypaolo.10xid.com/internal/cid-work-decks/';
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const privateHeaders = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'vary': 'Origin',
};

export async function GET(request: Request, {params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params;
  if (!isCidSlug(slug) || request.headers.get('origin') !== new URL(cidUrl(slug)).origin) {
    return Response.json({error: 'Company workspace not found.'}, {status: 404, headers: privateHeaders});
  }
  const headers = {
    ...privateHeaders,
    'access-control-allow-origin': new URL(cidUrl(slug)).origin,
    'access-control-allow-credentials': 'true',
  };
  const fail = (status: number, error: string) => Response.json({error}, {status, headers});
  const id = new URL(request.url).searchParams.get('deck');
  if (id !== null && !uuid.test(id)) return fail(404, 'Work Deck not found.');

  try {
    const session = await getLoginSession();
    if (!session?.mfaVerifiedAt) return fail(401, 'Sign in to 10XiD and complete your authenticator check.');
    const account = await userByAuthUserId(session.user.id);
    if (!account) return fail(403, 'Company Work Deck access required.');

    const secret = process.env.CID_WORK_DECKS_SECRET;
    if (!secret || !/^[a-f0-9]{64}$/.test(secret)) return fail(503, 'Company Work Decks are unavailable.');
    const companyPath = upstream + CID_COMPANIES[slug].organizationSlug;
    const response = await fetch(id ? companyPath + '/' + id : companyPath, {
      headers: {authorization: 'Bearer ' + secret, 'x-10xid-account': account.id},
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 403) return fail(403, 'Company Work Deck access required.');
    if (response.status === 404 && id) return fail(404, 'Work Deck not found.');
    if (!response.ok) return fail(503, 'Company Work Decks are unavailable.');
    return Response.json(await response.json(), {headers});
  } catch {
    return fail(503, 'Company Work Decks are unavailable.');
  }
}
