import "server-only";
import { MemberError, requiredClothingLevel } from "./member-policy";
import { uidClothingAccess, type UidActor } from "@/lib/db/uid-members";
import { uidSiteSecret, uidSites } from "@/lib/auth/uid-sites";

/** Where the clothing tools live (the same host /api/uid/assets loads their code from). */
const toolHost=()=>process.env.CLOTHING_UI_HOST||'uid-bypaolo.10xid.com';
/** A reading takes up to 110 seconds at the vision model. */
const PHOTO_TIMEOUT_MS=115_000;

/**
 * Photo reading runs on the clothing tools' own UiD, which holds the vision model's settings. Every
 * other UiD reaches it through here: the person's role was checked above, and that UiD is told who
 * is reading (x-uid-actor) over its machine-only route, signed with its site secret.
 */
async function photoReader(actor:UidActor,method:string,body:string|undefined,fetchImpl:typeof fetch){
  const host=toolHost(),secret=uidSiteSecret(host);
  const unavailable=method==='GET'
    ?Response.json({available:false,reason:'Photo reading is temporarily unavailable. You can still fill in the form.'},{headers:{'cache-control':'no-store'}})
    :null;
  if(!uidSites().has(host)||!secret){if(unavailable)return unavailable;throw new MemberError('Photo reading is not set up. You can still fill in the form.',503);}
  let response:Response;
  try{
    response=await fetchImpl(`https://${host}/internal/uid-photo-reader`,{method,redirect:'error',signal:AbortSignal.timeout(PHOTO_TIMEOUT_MS),
      headers:{authorization:'Bearer '+secret,'x-uid-actor':actor.email,...(body?{'content-type':'application/json'}:{})},
      body:method==='POST'?body:undefined});
  }catch{if(unavailable)return unavailable;throw new MemberError('The photo reading could not finish. Your photos and edits are still here. Please retry.',502);}
  if(!(response.headers.get('content-type')||'').startsWith('application/json')||response.status===401||response.status===404){
    if(unavailable)return unavailable;throw new MemberError('Photo reading is temporarily unavailable. You can still fill in the form.',503);
  }
  return new Response(response.body,{status:response.status,headers:{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
}

export async function clothingProxy(actor:UidActor,input:{business?:string;method?:string;path?:string;body?:string},fetchImpl=fetch){
  const method=input.method||'GET';
  if(!['GET','HEAD','POST','PUT'].includes(method))throw new MemberError('Method not allowed.',405);
  const path=String(input.path||'');
  if(!path.startsWith('/api/clothing')||/[\\#\x00-\x1f]/.test(path)||/%(?:2e|2f|5c)/i.test(path))throw new MemberError('Invalid inventory request.',422);
  const parsed=new URL(path,'https://inventory.invalid');
  if(parsed.origin!=='https://inventory.invalid'||!(parsed.pathname==='/api/clothing'||parsed.pathname.startsWith('/api/clothing/')))
    throw new MemberError('Invalid inventory request.',422);
  const access=await uidClothingAccess(actor,input.business);
  if(access.level<requiredClothingLevel(method,parsed.pathname))throw new MemberError('Your role does not allow this Clothing Inventory action.');
  if(parsed.pathname==='/api/clothing/photo-reader'){
    if(method!=='GET'&&method!=='POST')throw new MemberError('Method not allowed.',405);
    return photoReader(actor,method,input.body,fetchImpl);
  }
  const origin=new URL(process.env.CLOTHING_API_URL||'');
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
    throw new MemberError('The inventory connection needs attention.',503);
  parsed.searchParams.delete('business');
  const response=await fetchImpl(new URL(parsed.pathname+parsed.search,origin),{
    method,redirect:'error',signal:AbortSignal.timeout(20_000),
    headers:{authorization:'Bearer '+process.env.CLOTHING_API_KEY,'x-clothing-actor':actor.email,...(input.body?{'content-type':'application/json'}:{})},
    body:['GET','HEAD'].includes(method)?undefined:input.body,
  });
  const contentType=response.headers.get('content-type')||'application/json';
  if(!/^(application\/json|image\/(jpeg|png|webp))(;|$)/i.test(contentType))throw new MemberError('The inventory connection returned an unexpected response.',502);
  if(response.status===401||response.status===403)throw new MemberError('The inventory connection needs attention.',503);
  // A clothing photo id always names the same bytes, so its private browser caching is kept; nothing else is cached.
  const cache=response.headers.get('cache-control')||'',keep=response.ok&&/^image\//i.test(contentType)&&/^private, max-age=\d{1,8}, immutable$/.test(cache);
  return new Response(method==='HEAD'?null:response.body,{status:response.status,headers:{'content-type':contentType,'cache-control':keep?cache:'private, no-store','x-content-type-options':'nosniff'}});
}
