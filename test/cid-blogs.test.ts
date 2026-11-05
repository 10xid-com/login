import {beforeEach,test,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({session:vi.fn(),account:vi.fn(),editable:vi.fn(),save:vi.fn(),origin:vi.fn(),fetch:vi.fn()}));
vi.mock('@/lib/auth/login',()=>({getLoginSession:f.session,assertLoginOrigin:f.origin}));
vi.mock('@/lib/db/accounts',()=>({userByAuthUserId:f.account}));
vi.mock('@/lib/db/cid-profiles',()=>({editableCid:f.editable,saveCid:f.save}));
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

test('Stage workspace only permits its own CiD to frame it', async()=>{
 const request=new Request('https://login.10xid.com/auth/cid/workweartoronto/blogs?stage=1');
 f.fetch.mockResolvedValueOnce(new Response('<title>Blog Posts</title>',{headers:{'content-type':'text/html'}}));
 const embedded=await companyBlogs(request,'workweartoronto','workspace',true);
 expect(embedded.headers.get('content-security-policy')).toBe("frame-ancestors https://cid-workweartoronto.10xid.com; object-src 'none'; base-uri 'none'");
 expect(await embedded.text()).toContain('.cid-header > a');
 expect((await companyBlogs(req(),'workweartoronto','workspace',true)).headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
 f.session.mockResolvedValue(null);
 const expired=await companyBlogs(request,'workweartoronto','workspace',true);
 expect(expired.status).toBe(401);
 expect(expired.headers.get('location')).toBeNull();
});

test('native Blog Posts accepts only the matching CiD and still checks membership', async()=>{
 const url='https://login.10xid.com/api/cid/workweartoronto/blogs/api/state/drafts';
 const origin='https://cid-workweartoronto.10xid.com';
 const request=(method:string, site=origin)=>new Request(url,{method,headers:{origin:site}});
 const preflight=await companyBlogs(request('OPTIONS'),'workweartoronto','api/state/drafts');
 expect(preflight.status).toBe(204);
 expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
 expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
 expect((await companyBlogs(request('OPTIONS','https://cid-rotary.10xid.com'),'workweartoronto','api/state/drafts')).status).toBe(403);
 f.origin.mockRejectedValue(Error('Wrong origin'));
 expect((await companyBlogs(request('PUT','https://cid-rotary.10xid.com'),'workweartoronto','api/state/drafts')).status).toBe(403);
 expect(f.fetch).not.toHaveBeenCalled();
 f.editable.mockRejectedValueOnce(new MemberError('Revoked'));
 expect((await companyBlogs(request('PUT'),'workweartoronto','api/state/drafts')).status).toBe(403);
 const saved=await companyBlogs(request('PUT'),'workweartoronto','api/state/drafts');
 expect(saved.status).toBe(200);
 expect(saved.headers.get('access-control-allow-origin')).toBe(origin);
});

test('native assets scope the shared editor to the company tool and its credentialed transport', async()=>{
 const request=new Request('https://login.10xid.com/api/cid/workweartoronto/blogs/assets/post-stage.js?native=1',{
  headers:{origin:'https://cid-workweartoronto.10xid.com'}
 });
 f.fetch.mockResolvedValueOnce(new Response('document.body.classList.add("post-open");',{headers:{'content-type':'text/javascript'}}));
 const response=await companyBlogs(request,'workweartoronto','assets/post-stage.js');
 expect(await response.text()).toContain("document.getElementById('companyTool').classList");
 expect(f.fetch.mock.calls[0][0]).not.toContain('native=1');
});

test('native Edit CiD requires the matching origin, MFA and a versioned save', async()=>{
 const { GET, PUT }=await import('@/app/api/cid/[slug]/editor/route');
 const params={params:Promise.resolve({slug:'workweartoronto'})};
 const url='https://login.10xid.com/api/cid/workweartoronto/editor';
 const origin='https://cid-workweartoronto.10xid.com';
 expect((await GET(new Request(url,{headers:{origin:'https://cid-rotary.10xid.com'}}),params)).status).toBe(403);
 f.session.mockResolvedValueOnce(null);
 expect((await GET(new Request(url,{headers:{origin}}),params)).status).toBe(401);
 f.editable.mockResolvedValueOnce({profile:{displayName:'Company'},version:3});
 const edit=await GET(new Request(url,{headers:{origin}}),params);
 expect(edit.headers.get('access-control-allow-origin')).toBe(origin);
 expect((await edit.json()).version).toBe(3);
 f.save.mockResolvedValue({saved:true,version:4});
 const publish=await PUT(new Request(url,{method:'PUT',headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({profile:{displayName:'Updated'},version:3})
 }),params);
 expect(f.save).toHaveBeenCalledWith('workweartoronto','member',{displayName:'Updated'},3);
 expect((await publish.json()).version).toBe(4);
});
