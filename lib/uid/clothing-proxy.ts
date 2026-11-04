import "server-only";
import { MemberError, requiredClothingLevel } from "./member-policy";
import { uidClothingAccess, type UidActor } from "@/lib/db/uid-members";

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
    if(method!=='GET')throw new MemberError('Photo reading is not configured for shared inventory.',503);
    return Response.json({available:false,reason:'Photo reading is not configured for shared inventory.'},{headers:{'cache-control':'no-store'}});
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
  return new Response(method==='HEAD'?null:response.body,{status:response.status,headers:{'content-type':contentType,'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
}
