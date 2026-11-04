import {beforeEach,describe,it,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({origin:vi.fn(),session:vi.fn(),account:vi.fn(),save:vi.fn(),public:vi.fn()}));
vi.mock('@/lib/auth/login',()=>({assertLoginOrigin:f.origin,getLoginSession:f.session}));
vi.mock('@/lib/db/accounts',()=>({userByAuthUserId:f.account}));
vi.mock('@/lib/db/cid-profiles',()=>({saveCid:f.save,publicCid:f.public}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw Error('REDIRECT '+url);}}));
import {publishCid} from '@/app/auth/cid/[slug]/actions';
import {GET} from '@/app/api/cid/[slug]/route';
import {MemberError} from '@/lib/uid/member-policy';
const form=()=>{const value=new FormData();value.set('displayName','Company');value.set('version','1');value.set('role','owner');return value;};
beforeEach(()=>{vi.resetAllMocks();f.session.mockResolvedValue({mfaVerifiedAt:new Date(),user:{id:'auth-person'}});f.account.mockResolvedValue({id:'bound-account'});f.save.mockResolvedValue({saved:true});});
describe('CiD sign-in, CSRF and server action boundaries',()=>{
 it('requires sign-in before attempting any edit',async()=>{
  f.session.mockResolvedValue(null);await expect(publishCid('rotary',form())).rejects.toThrow('/auth/sign-in?next=');expect(f.save).not.toHaveBeenCalled();
 });
 it('requires MFA and a bound account',async()=>{
  f.session.mockResolvedValue({user:{id:'auth-person'}});await expect(publishCid('rotary',form())).rejects.toThrow('/auth/mfa?next=');
  f.session.mockResolvedValue({mfaVerifiedAt:new Date(),user:{id:'auth-person'}});f.account.mockResolvedValue(null);
  await expect(publishCid('rotary',form())).rejects.toThrow('/auth/access?next=');expect(f.save).not.toHaveBeenCalled();
 });
 it('rejects cross-origin submissions and unknown companies before saving',async()=>{
  f.origin.mockRejectedValue(Error('Wrong origin'));await expect(publishCid('rotary',form())).rejects.toThrow('Wrong origin');
  await expect(publishCid('foreign',form())).rejects.toThrow('Company not found');expect(f.save).not.toHaveBeenCalled();
 });
 it('uses the session account, filters form fields and only reports success after persistence',async()=>{
  await expect(publishCid('rotary',form())).rejects.toThrow('/auth/cid/rotary?saved=1');
  expect(f.save).toHaveBeenCalledWith('rotary','bound-account',expect.objectContaining({displayName:'Company',showOwnership:false}),1);
  expect(f.save.mock.calls[0][2]).not.toHaveProperty('role');
 });
 it('handles permission removal and concurrent changes without publishing',async()=>{
  f.save.mockRejectedValue(new MemberError('Revoked',403));await expect(publishCid('rotary',form())).rejects.toThrow('?error=denied');
  f.save.mockRejectedValue(new MemberError('Conflict',409));await expect(publishCid('rotary',form())).rejects.toThrow('?error=conflict');
 });
 it('serves public GET without authentication and fails closed on an unavailable database',async()=>{
  f.public.mockResolvedValue({slug:'rotary',profile:{displayName:'Rotary'}});
  const response=await GET(new Request('https://login.10xid.com/api/cid/rotary'),{params:Promise.resolve({slug:'rotary'})});
  expect(response.status).toBe(200);expect(f.session).not.toHaveBeenCalled();expect(response.headers.get('cache-control')).toBe('no-store');
  f.public.mockRejectedValue(Error('secret database details'));const failed=await GET(new Request('https://login.10xid.com/api/cid/rotary'),{params:Promise.resolve({slug:'rotary'})});
  expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('secret');
 });
});
