import {beforeEach,describe,it,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({account:vi.fn(),addresses:vi.fn(),live:vi.fn(),limit:vi.fn()}));
vi.mock('@/lib/db/auth-connection',()=>({authDb:()=>({select:()=>({from:()=>({where:()=>({limit:f.limit})})})})}));
vi.mock('@/lib/db/accounts',()=>({userByAuthUserId:f.account,accountAddresses:f.addresses}));
vi.mock('@/lib/db/identity',()=>({authSessionLive:f.live}));
import {authenticateUid} from '@/lib/uid/authenticate';
import {uidSiteSecret} from '@/lib/auth/uid-sites';
const host='uid-ethan.10xid.com',email='ethan@example.com',session='signed-in-session-000001';
beforeEach(()=>{
 process.env.UID_SITE_KEY='k'.repeat(40);process.env.UID_SITES=`${host}=${email}|paolo@example.com,uid-bypaolo.10xid.com=paolo@example.com`;
 f.limit.mockResolvedValue([{userId:'auth-ethan'}]);f.live.mockResolvedValue(true);
 f.account.mockResolvedValue({id:'account-ethan',fullName:'Ethan'});f.addresses.mockResolvedValue([email]);
});
describe('host-bound UiD sign-in and person binding',()=>{
 it('resolves a live MFA account using the server secret',async()=>{
  expect((await authenticateUid('Bearer '+uidSiteSecret(host),{host,email,session})).userId).toBe('account-ethan');
 });
 it('refuses another UiD key and a forged person on an otherwise live session',async()=>{
  await expect(authenticateUid('Bearer '+uidSiteSecret('uid-bypaolo.10xid.com'),{host,email,session})).rejects.toThrow('Sign in again');
  await expect(authenticateUid('Bearer '+uidSiteSecret(host),{host,email:'paolo@example.com',session})).rejects.toThrow('Sign in again');
 });
 it('fails closed when the central sign-in was revoked',async()=>{
  f.live.mockResolvedValue(false);
  await expect(authenticateUid('Bearer '+uidSiteSecret(host),{host,email,session})).rejects.toThrow('Sign in again');
 });
});
