import 'server-only';
import {getLoginSession,assertLoginOrigin} from '@/lib/auth/login';
import {userByAuthUserId} from '@/lib/db/accounts';
import {editableCid} from '@/lib/db/cid-profiles';
import {isCidSlug,cidUrl} from './profile';
import {MemberError} from '@/lib/uid/member-policy';
import {uidSiteSecret} from '@/lib/auth/uid-sites';
const HOST='uid-rana.10xid.com';
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const fail=(status:number,error:string)=>Response.json({error},{status,headers});
/** The browser never receives the Rana service credential or chooses an upstream host. */
export async function companyBlogs(request:Request,slug:string,path:string,workspace=false){
 if(!isCidSlug(slug))return fail(404,'Company not found.');
 const back='/auth/cid/'+slug+'/blogs';
 const session=await getLoginSession();
 if(!session)return workspace?Response.redirect(new URL('/auth/sign-in?next='+encodeURIComponent(back),request.url),307):fail(401,'Sign in again.');
 if(!session.mfaVerifiedAt)return workspace?Response.redirect(new URL('/auth/mfa?next='+encodeURIComponent(back),request.url),307):fail(401,'Complete your authenticator check.');
 const account=await userByAuthUserId(session.user.id);
 if(!account)return workspace?Response.redirect(cidUrl(slug),307):fail(403,'Company editing access required.');
 try{await editableCid(slug,account.id);}catch(error){
  if(error instanceof MemberError&&error.status===403)return workspace?Response.redirect(cidUrl(slug),307):fail(403,'Company editing access required.');
  return fail(503,'Company access is temporarily unavailable. Please retry.');
 }
 if(!['GET','HEAD'].includes(request.method)){
  try{await assertLoginOrigin();}catch{return fail(403,'Changes must come from this page.');}
 }
 if(!/^(workspace|assets\/(?:[a-z0-9.-]+|v3\/styles.css)|api\/[a-z0-9/-]+)$/.test(path))return fail(404,'Not found.');
 const secret=uidSiteSecret(HOST);if(!secret)return fail(503,'Blog Posts is temporarily unavailable.');
 try{
  let body:Uint8Array|undefined;
  if(!['GET','HEAD'].includes(request.method)){
   const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
   if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();return fail(413,'Request too large.');}chunks.push(value);}
   body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
  }
  const upstream=await fetch('https://'+HOST+'/internal/cid-blogs/'+slug+'/'+path+new URL(request.url).search,{
   method:request.method,headers:{authorization:'Bearer '+secret,'content-type':request.headers.get('content-type')||'application/json',
    'x-cid-email':session.user.email,'x-cid-name':session.user.name||session.user.email,'x-filename':request.headers.get('x-filename')||''},
   body:body as BodyInit|undefined,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(60_000)
  });
  const type=upstream.headers.get('content-type')||'';
  if(!/^(application\/json|text\/(html|css|javascript))(;|$)/.test(type))return fail(502,'Blog Posts returned an unexpected response.');
  return new Response(upstream.body,{status:upstream.status,headers:{...headers,'content-type':type,
   ...(workspace?{'content-security-policy':"frame-ancestors 'none'; object-src 'none'; base-uri 'none'"}:{})}});
 }catch{return fail(503,'Blog Posts is temporarily unavailable. Please retry.');}
}
