import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// Wiring only: auth, throttle, DB and cache are mocked. Nothing here reaches a database.
const m=vi.hoisted(()=>({
 session:null as null|{sessionId:string;mfaVerifiedAt:Date|null;user:{id:string}},
 mfaVerify:vi.fn(),allow:vi.fn(),revalidatePath:vi.fn(),redirect:vi.fn(),
 start:vi.fn(),complete:vi.fn(),revoke:vi.fn(),
}));
vi.mock('next/headers',()=>({headers:async()=>new Headers()}));
vi.mock('next/cache',()=>({revalidatePath:m.revalidatePath}));
vi.mock('next/navigation',()=>({redirect:m.redirect}));
vi.mock('better-auth/api',()=>({APIError:class APIError extends Error{body?:unknown}}));
vi.mock('@/lib/auth/auth',()=>({getAuth:()=>({api:{mfaVerify:m.mfaVerify}})}));
vi.mock('@/lib/auth/throttle',()=>({allow:m.allow}));
vi.mock('@/lib/auth/login',()=>({assertLoginOrigin:async()=>{},getLoginSession:async()=>m.session}));
vi.mock('@/lib/db/signin-links',()=>({startSigninLink:m.start,completeSigninLink:m.complete,revokeSigninLink:m.revoke}));
import {startSigninLinkAction,completeSigninLinkAction,revokeSigninLinkAction} from '@/app/auth/signin-link-actions';
import {SigninLinksPanel,LINK_REASONS,failureText} from '@/app/auth/signin-links-panel';

const form=(o:Record<string,string>)=>{const f=new FormData();for(const [k,v] of Object.entries(o))f.set(k,v);return f;};
const LINK='11111111-1111-4111-8111-111111111111';
beforeEach(()=>{
 vi.clearAllMocks();
 m.session={sessionId:'s1',mfaVerifiedAt:new Date(),user:{id:'a1'}};
 m.allow.mockResolvedValue(true);m.mfaVerify.mockResolvedValue({});
});

describe('server actions require a fresh authenticator and never redirect',()=>{
 it('start returns the code in the result only, with the chosen primary side',async()=>{
  m.start.mockResolvedValue({ok:true,code:'ABCDE-FGHJK'});
  expect(await startSigninLinkAction(form({totp:'123456',primary:'other'}))).toEqual({ok:true,code:'ABCDE-FGHJK'});
  expect(m.start).toHaveBeenCalledWith('s1','redeemer');
  expect(m.mfaVerify).toHaveBeenCalledWith(expect.objectContaining({body:{code:'123456'}}));
  expect(m.redirect).not.toHaveBeenCalled();
  expect(JSON.stringify(m.revalidatePath.mock.calls)).not.toContain('ABCDE');
 });
 it.each([
  ['signed out',()=>{m.session=null;},{totp:'123456'},'sign_in'],
  ['no MFA on session',()=>{m.session!.mfaVerifiedAt=null;},{totp:'123456'},'sign_in'],
  ['rate limited',()=>{m.allow.mockResolvedValue(false);},{totp:'123456'},'rate'],
  ['malformed code',()=>{},{totp:'12ab56'},'totp'],
 ])('stops before the database when %s',async(_n,arrange,input,reason)=>{
  arrange();
  expect(await startSigninLinkAction(form(input))).toEqual({ok:false,reason});
  expect(m.start).not.toHaveBeenCalled();
 });
 it('complete links, refreshes both account routes and passes only the typed code',async()=>{
  m.complete.mockResolvedValue('linked');
  expect(await completeSigninLinkAction(form({totp:'123456',code:'abcde-fghjk'}))).toEqual({ok:true});
  expect(m.complete).toHaveBeenCalledWith('s1','abcde-fghjk');
  expect(m.revalidatePath.mock.calls.map(c=>c[0]).sort()).toEqual(['/auth/account','/auth/pid']);
  expect(m.redirect).not.toHaveBeenCalled();
 });
 it('complete surfaces database refusals without refreshing',async()=>{
  m.complete.mockResolvedValue('invalid');
  expect(await completeSigninLinkAction(form({totp:'123456',code:'x'}))).toEqual({ok:false,reason:'invalid'});
  expect(m.revalidatePath).not.toHaveBeenCalled();
 });
 it('revoke needs a uuid and refreshes on success',async()=>{
  expect(await revokeSigninLinkAction(form({totp:'123456',link:'nope'}))).toEqual({ok:false,reason:'invalid'});
  expect(m.revoke).not.toHaveBeenCalled();
  m.revoke.mockResolvedValue('revoked');
  expect(await revokeSigninLinkAction(form({totp:'123456',link:LINK}))).toEqual({ok:true});
  expect(m.revoke).toHaveBeenCalledWith('s1',LINK);
  expect(m.revalidatePath).toHaveBeenCalledWith('/auth/account');
 });
});

describe('account panel',()=>{
 const html=(links:Parameters<typeof SigninLinksPanel>[0]['links'])=>renderToStaticMarkup(createElement(SigninLinksPanel,{links}));
 it('explains the steps and security assumptions and has the three flows, with no code in markup',()=>{
  const out=html([]);
  expect(out).toContain('two browser profiles');
  expect(out).toContain('never gives either account a role');
  expect(out).toContain('No verified links yet.');
  expect(out).toContain('Get a link code');expect(out).toContain('Link these accounts');
  expect(out).toContain('type="password"');
  expect(out).not.toMatch(/href="[^"]*(code|totp)=/i);
 });
 it('shows alternate memberships as view-only discovery, with the revoke form and no sign-in-as action',()=>{
  const out=html([{linkId:LINK,email:'two@example.com',name:'Two',primary:true,verifiedAt:'2026-11-01T00:00:00Z',memberships:[{id:'o',name:'Beta',roleLabel:'Viewer'}]}]);
  expect(out).toContain('Beta (Viewer)');expect(out).toContain('view only');
  expect(out).toContain('End this link');expect(out).toContain(LINK);
  expect(out).toContain('own browser profile');
 });
 it('has a plain-language message for every reason the actions can return',()=>{
  for(const r of ['sign_in','rate','totp','locked','no_session','not_fresh','unsettled','limit','same_account','exists','invalid','not_found'])expect(LINK_REASONS[r]).toBeTruthy();
  expect(failureText('something_new')).toBe(LINK_REASONS.invalid);
 });
});
