import {beforeEach,test,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({session:vi.fn(),account:vi.fn(),editable:vi.fn(),origin:vi.fn(),fetch:vi.fn()}));
vi.mock('@/lib/auth/login',()=>({getLoginSession:f.session,assertLoginOrigin:f.origin}));
vi.mock('@/lib/db/accounts',()=>({userByAuthUserId:f.account}));
vi.mock('@/lib/db/cid-profiles',()=>({editableCid:f.editable}));
vi.mock('@/lib/auth/uid-sites',()=>({uidSiteSecret:()=> 'server-only-secret'}));
import {companyBlogs} from '@/lib/cid/blogs';
import {MemberError} from '@/lib/uid/member-policy';
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('fetch',f.fetch);f.session.mockResolvedValue({mfaVerifiedAt:new Date(),user:{id:'auth-person',email:'editor@example.com',name:'Editor'}});f.account.mockResolvedValue({id:'member'});f.editable.mockResolvedValue({});f.origin.mockResolvedValue(undefined);f.fetch.mockResolvedValue(new Response('{}',{headers:{'content-type':'application/json'}}));});
const req=(method='GET')=>new Request('https://login.10xid.com/auth/cid/workweartoronto/blogs',{method,headers:{cookie:'private-cookie',authorization:'client-controlled'}});
test('signed-out and MFA-unverified visitors must authenticate',async()=>{
 f.session.mockResolvedValue(null);expect((await companyBlogs(req(),'workweartoronto','workspace',true)).headers.get('location')).toContain('/auth/sign-in?next=');
 f.session.mockResolvedValue({user:{id:'a'}});expect((await companyBlogs(req(),'workweartoronto','workspace',true)).headers.get('location')).toContain('/auth/mfa?next=');expect(f.fetch).not.toHaveBeenCalled();
});
test('non-members go to the public CiD and cannot request drafts or assets',async()=>{
 f.editable.mockRejectedValue(new MemberError('Not a member'));
 expect((await companyBlogs(req(),'workweartoronto','workspace',true)).headers.get('location')).toBe('https://cid-workweartoronto.10xid.com/');
 expect((await companyBlogs(req(),'workweartoronto','api/state')).status).toBe(403);expect(f.fetch).not.toHaveBeenCalled();
});
test('every call rechecks live company access; credentials and host come from the server',async()=>{
 await companyBlogs(req(),'workweartoronto','api/state');
 expect(f.editable).toHaveBeenCalledWith('workweartoronto','member');
 const [url,init]=f.fetch.mock.calls[0];expect(url).toBe('https://uid-rana.10xid.com/internal/cid-blogs/workweartoronto/api/state');
 expect(init.headers.authorization).toBe('Bearer server-only-secret');expect(init.headers.cookie).toBeUndefined();expect(init.headers['x-cid-email']).toBe('editor@example.com');
 f.editable.mockRejectedValue(new MemberError('Revoked'));expect((await companyBlogs(req(),'workweartoronto','api/state')).status).toBe(403);expect(f.fetch).toHaveBeenCalledTimes(1);
});
test('cross-origin changes and unknown paths fail before upstream traffic',async()=>{
 f.origin.mockRejectedValue(Error('Wrong origin'));expect((await companyBlogs(req('PUT'),'workweartoronto','api/state/drafts')).status).toBe(403);
 expect((await companyBlogs(req(),'workweartoronto','../../private')).status).toBe(404);expect(f.fetch).not.toHaveBeenCalled();
});
