import 'server-only';
import {getLoginSession,assertLoginOrigin} from '@/lib/auth/login';
import {userByAuthUserId} from '@/lib/db/accounts';
import {editableCid} from '@/lib/db/cid-profiles';
import {isCidSlug,cidUrl} from './profile';
import {cidStagePolicy} from './stage';
import {MemberError} from '@/lib/uid/member-policy';
import {uidSiteSecret} from '@/lib/auth/uid-sites';
const HOST='uid-rana.10xid.com';
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const fail=(status:number,error:string)=>Response.json({error},{status,headers});
const nativeScripts = new Set(['assets/post-model.js','assets/post-blocks.js','assets/post-stage.js','assets/post-shop.js','assets/post-publish.js']);

function nativeAsset(path:string, source:string) {
 if(path==='assets/rana.css')return '@scope (#companyTool) {\n'+source+'\n}';
 // Keep the shared editor's fetch and draft cache inside this workspace.
 return '(function(fetch,localStorage){\n'+source.replaceAll("document.body.classList", "document.getElementById('companyTool').classList")+
  '\n})(window.CidBlog.request,window.CidBlog.draftCache);';
}
/** The browser never receives the Rana service credential or chooses an upstream host. */
export async function companyBlogs(request:Request,slug:string,path:string,workspace=false){
 if(!isCidSlug(slug))return fail(404,'Company not found.');
 const url=new URL(request.url);
 const origin=request.headers.get('origin');
 const fromCiD=!workspace&&origin===new URL(cidUrl(slug)).origin;
 const cors:Record<string,string>=fromCiD?{'access-control-allow-origin':origin,'access-control-allow-credentials':'true','vary':'Origin'}:{};
 if(request.method==='OPTIONS'){
  if(!fromCiD)return fail(403,'Use this company’s CiD.');
  return new Response(null,{status:204,headers:{...headers,...cors,
   'access-control-allow-methods':'GET, POST, PUT, DELETE, OPTIONS',
   'access-control-allow-headers':'Content-Type, X-Filename'}});
 }
 const failRequest=(status:number,error:string)=>Response.json({error},{status,headers:{...headers,...cors}});
 const native=fromCiD&&url.searchParams.get('native')==='1'&&(nativeScripts.has(path)||path==='assets/rana.css');
 if(native)url.searchParams.delete('native');
 const inStage=workspace&&url.searchParams.get('stage')==='1';
 const framePolicy=inStage?cidStagePolicy(slug):"frame-ancestors 'none'; object-src 'none'; base-uri 'none'";
 const stageError=(status:number,error:string)=>new Response(error,{status,headers:{...headers,
  'content-type':'text/plain; charset=utf-8','content-security-policy':framePolicy}});
 const back='/auth/cid/'+slug+'/blogs';
 const session=await getLoginSession();
 if(!session)return inStage?stageError(401,'Sign in to 10XiD to open Blog Posts.'):workspace?Response.redirect(new URL('/auth/sign-in?next='+encodeURIComponent(back),request.url),307):failRequest(401,'Sign in again.');
 if(!session.mfaVerifiedAt)return inStage?stageError(401,'Complete your 10XiD authenticator check to open Blog Posts.'):workspace?Response.redirect(new URL('/auth/mfa?next='+encodeURIComponent(back),request.url),307):failRequest(401,'Complete your authenticator check.');
 const account=await userByAuthUserId(session.user.id);
 if(!account)return inStage?stageError(403,'Company editing access is required.'):workspace?Response.redirect(cidUrl(slug),307):failRequest(403,'Company editing access required.');
 try{await editableCid(slug,account.id);}catch(error){
  if(error instanceof MemberError&&error.status===403)return inStage?stageError(403,'Company editing access is required.'):workspace?Response.redirect(cidUrl(slug),307):failRequest(403,'Company editing access required.');
  return failRequest(503,'Company access is temporarily unavailable. Please retry.');
 }
 if(!fromCiD&&!['GET','HEAD'].includes(request.method)){
  try{await assertLoginOrigin();}catch{return failRequest(403,'Changes must come from this page.');}
 }
 if(!/^(workspace|assets\/(?:[a-z0-9.-]+|v3\/styles.css)|api\/[a-z0-9/-]+)$/.test(path))return failRequest(404,'Not found.');
 const secret=uidSiteSecret(HOST);if(!secret)return failRequest(503,'Blog Posts is temporarily unavailable.');
 try{
  let body:Uint8Array|undefined;
  if(!['GET','HEAD'].includes(request.method)){
   const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
   if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();return failRequest(413,'Request too large.');}chunks.push(value);}
   body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
  }
  const upstream=await fetch('https://'+HOST+'/internal/cid-blogs/'+slug+'/'+path+url.search,{
   method:request.method,headers:{authorization:'Bearer '+secret,'content-type':request.headers.get('content-type')||'application/json',
    'x-cid-email':session.user.email,'x-cid-name':session.user.name||session.user.email,'x-filename':request.headers.get('x-filename')||''},
   body:body as BodyInit|undefined,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(60_000)
  });
  const type=upstream.headers.get('content-type')||'';
  if(!/^(application\/json|text\/(html|css|javascript))(;|$)/.test(type))return failRequest(502,'Blog Posts returned an unexpected response.');
  const bodyContent=inStage&&type.startsWith('text/html')
   ? (await upstream.text()).replace('</title>','</title><style>.cid-header > a { display: none }</style>')
   : native&&upstream.ok ? nativeAsset(path,await upstream.text()) : upstream.body;
  return new Response(bodyContent,{status:upstream.status,headers:{...headers,...cors,'content-type':type,
   ...(workspace?{'content-security-policy':framePolicy}:{})}});
 }catch{return failRequest(503,'Blog Posts is temporarily unavailable. Please retry.');}
}
