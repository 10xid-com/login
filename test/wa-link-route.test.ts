import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ session: vi.fn(), account: vi.fn(), mint: vi.fn(), verify: vi.fn(), allow: vi.fn() }));
vi.mock('@/lib/auth/login', () => ({ getLoginSession: mocks.session }));
vi.mock('@/lib/db/accounts', () => ({ userByAuthUserId: mocks.account }));
vi.mock('@/lib/db/identity', () => ({ mintTicket: mocks.mint }));
vi.mock('@/lib/auth/auth', () => ({ getAuth: () => ({ api: { mfaVerify: mocks.verify } }) }));
vi.mock('@/lib/auth/throttle', () => ({ allow: mocks.allow }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
import { GET, POST } from '../app/auth/wa/authorize/route';
const login = 'https://staging-login.example.test', wa = 'https://staging-wa.example.test';
const state = 'a'.repeat(32);
function session(at: Date | null = new Date()) { return { sessionId: 'auth-session-a', mfaVerifiedAt: at, user: { id: 'auth-user-a', email: 'buyer@example.test', emailVerified: true } }; }
async function challenge() {
  const url = new URL('/auth/wa/authorize', login);
  url.search = new URLSearchParams({ client_id: 'wa-stage', redirect_uri: wa + '/api/wrapauthority/10xid/callback', state }).toString();
  const response = await GET(new NextRequest(url, { headers: { host: new URL(login).host } }));
  return { response, token: response.cookies.get('__Host-wa_consent')?.value || '' };
}
function post(token: string, extra: Record<string,string> = {}, origin = login) {
  const form = new FormData(); form.set('challenge', token); form.set('consent','yes');
  for (const [k,v] of Object.entries(extra)) form.set(k,v);
  return POST(new NextRequest(login + '/auth/wa/authorize', { method:'POST', headers: { origin, cookie: '__Host-wa_consent=' + token }, body: form }));
}
beforeEach(() => {
  vi.stubEnv('WA_INTEGRATION_ENV','staging'); vi.stubEnv('WA_STAGING_ORIGIN',wa);
  vi.stubEnv('WA_STAGING_LOGIN_ORIGIN',login); vi.stubEnv('WA_STAGING_PORTAL_ORIGIN','https://staging-portal.example.test');
  vi.stubEnv('WA_EXTERNAL_CLIENT_ID','wa-stage'); vi.stubEnv('WA_EXTERNAL_CLIENT_SECRET','s'.repeat(48));
  mocks.session.mockReset().mockResolvedValue(session()); mocks.account.mockReset().mockResolvedValue({ id:'10000000-0000-4000-8000-000000000001', isService:false, deletedAt:null });
  mocks.allow.mockReset().mockResolvedValue(true); mocks.verify.mockReset().mockResolvedValue({ status:true }); mocks.mint.mockReset().mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());
describe('WA linking consent and MFA', () => {
  it('GET only prepares consent and never issues an authorization ticket', async () => {
    const {response,token}=await challenge(); expect(token).not.toBe('');
    expect(response.headers.get('location')).toBe(login+'/auth/wa/confirm'); expect(mocks.mint).not.toHaveBeenCalled();
  });
  it('refuses missing explicit consent, cross-origin POST, and changed sessions', async () => {
    const {token}=await challenge();
    expect((await post(token,{consent:'no'})).status).toBe(403);
    expect((await post(token,{},'https://attacker.test')).status).toBe(403);
    mocks.session.mockResolvedValue({...session(),sessionId:'other'});
    expect((await post(token)).status).toBe(403); expect(mocks.mint).not.toHaveBeenCalled();
  });
  it('requires a new authenticator proof for a stale session', async () => {
    mocks.session.mockResolvedValue(session(new Date(Date.now()-301000)));
    const {token}=await challenge(); expect((await post(token)).status).toBe(403);
    mocks.verify.mockRejectedValueOnce(new Error('bad code'));
    expect((await post(token,{code:'123456'})).status).toBe(403); expect(mocks.mint).not.toHaveBeenCalled();
    const response=await post(token,{code:'654321'});
    expect(response.status).toBe(303); expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.mint.mock.calls[0][0].audienceHost).toBe('staging-wa.example.test');
    expect(new URL(response.headers.get('location')!).origin).toBe(wa);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('refuses a tampered challenge before minting', async () => {
    const {token}=await challenge(); expect((await post(token+'x')).status).toBe(403); expect(mocks.mint).not.toHaveBeenCalled();
  });
  it('fresh MFA plus explicit consent mints a single short-lived audience-bound ticket', async () => {
    const {token}=await challenge(); const response=await post(token);
    expect(response.status).toBe(303); expect(mocks.verify).not.toHaveBeenCalled(); expect(mocks.mint).toHaveBeenCalledTimes(1);
    const input=mocks.mint.mock.calls[0][0]; expect(input.sourceAuthSessionId).toBe('auth-session-a');
    expect(input.expiresAt.getTime()-Date.now()).toBeLessThanOrEqual(60000);
    expect(new URL(response.headers.get('location')!).searchParams.get('state')).toBe(state);
  });
});
