import {isCidSlug} from '@/lib/cid/profile';
import {publicCid} from '@/lib/db/cid-profiles';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** Public projection only. No cookies, member directory, private fields or mutation API. */
export async function GET(_request:Request,{params}:{params:Promise<{slug:string}>}){
  const {slug}=await params;
  const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
  if(!isCidSlug(slug))return Response.json({error:'Company not found.'},{status:404,headers});
  try{return Response.json(await publicCid(slug),{headers});}
  catch{ return Response.json({error:'Company profile is temporarily unavailable.'},{status:503,headers}); }
}
