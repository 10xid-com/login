import {beforeEach,test,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({session:vi.fn(),account:vi.fn(),editable:vi.fn()}));
vi.mock('@/lib/auth/login',()=>({getLoginSession:f.session}));
vi.mock('@/lib/db/accounts',()=>({userByAuthUserId:f.account}));
vi.mock('@/lib/db/cid-profiles',()=>({editableCid:f.editable}));
import {GET} from '@/app/api/cid/[slug]/access/route';
import {MemberError} from '@/lib/uid/member-policy';
const call=(slug='workweartoronto',origin='https://cid-'+slug+'.10xid.com')=>GET(new Request('https://login.10xid.com/api/cid/'+slug+'/access',{headers:{origin}}),{params:Promise.resolve({slug})});
beforeEach(()=>{vi.resetAllMocks();f.session.mockResolvedValue({mfaVerifiedAt:new Date(),user:{id:'auth-member',email:'private@example.com'}});f.account.mockResolvedValue({id:'assigned-member'});f.editable.mockResolvedValue({profile:{private:'never returned'}});});
test('public controls stay hidden for signed-out, incomplete MFA and unbound accounts',async()=>{
 f.session.mockResolvedValue(null);expect(await (await call()).json()).toEqual({canEdit:false});
 f.session.mockResolvedValue({user:{id:'auth-member'}});expect(await (await call()).json()).toEqual({canEdit:false});
 f.session.mockResolvedValue({mfaVerifiedAt:new Date(),user:{id:'auth-member'}});f.account.mockResolvedValue(null);expect(await (await call()).json()).toEqual({canEdit:false});expect(f.editable).not.toHaveBeenCalled();
});
test('viewers, unrelated accounts, explicit denies and removed memberships reveal no controls',async()=>{
 f.editable.mockRejectedValue(new MemberError('No editing permission'));expect(await (await call()).json()).toEqual({canEdit:false});
});
test.each(['rotary','brandingcentres','vinylwraptoronto','wrapauthority','workweartoronto'])('only the matching %s public origin can read the boolean access hint',async slug=>{
 const r=await call(slug);expect(await r.json()).toEqual({canEdit:true});expect(r.headers.get('access-control-allow-origin')).toBe('https://cid-'+slug+'.10xid.com');
 expect(r.headers.get('access-control-allow-credentials')).toBe('true');expect(r.headers.get('cache-control')).toBe('private, no-store');
 expect(f.editable).toHaveBeenCalledWith(slug,'assigned-member');
});
test('foreign origins, sibling companies and fabricated companies fail before accessing sessions',async()=>{
 for(const origin of ['https://evil.example','https://cid-workweartoronto.10xid.com.evil.example','https://cid-rotary.10xid.com','null']){
  const r=await call('workweartoronto',origin);expect(r.status).toBe(403);expect(r.headers.get('access-control-allow-origin')).toBeNull();
 }
 expect((await call('foreign')).status).toBe(404);expect(f.session).not.toHaveBeenCalled();
});
test('unavailable authorization fails closed without exposing account or profile data',async()=>{
 f.editable.mockRejectedValue(Error('database details'));const r=await call();expect(r.status).toBe(503);expect(await r.json()).toEqual({canEdit:false});
});
