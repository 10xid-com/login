import {getLoginSession} from '@/lib/auth/login';
import {userByAuthUserId} from '@/lib/db/accounts';
import {editableCid} from '@/lib/db/cid-profiles';
import {isCidSlug,cidUrl} from '@/lib/cid/profile';
import {MemberError} from '@/lib/uid/member-policy';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** Cross-origin UI hint only. The public site receives no account or private company data. */
export async function GET(request:Request,{params}:{params:Promise<{slug:string}>}){
 const {slug}=await params;
 const base={'cache-control':'private, no-store','vary':'Origin','x-content-type-options':'nosniff'};
 if(!isCidSlug(slug))return Response.json({canEdit:false},{status:404,headers:base});
 const origin=new URL(cidUrl(slug)).origin;
 if(request.headers.get('origin')!==origin)return Response.json({canEdit:false},{status:403,headers:base});
 const headers={...base,'access-control-allow-origin':origin,'access-control-allow-credentials':'true'};
 try{
  const session=await getLoginSession();
  if(!session?.mfaVerifiedAt)return Response.json({canEdit:false},{headers});
  const account=await userByAuthUserId(session.user.id);
  if(!account)return Response.json({canEdit:false},{headers});
  try{await editableCid(slug,account.id);}catch(error){
   if(error instanceof MemberError)return Response.json({canEdit:false},{headers});
   throw error;
  }
  return Response.json({canEdit:true},{headers});
 }catch{return Response.json({canEdit:false},{status:503,headers});}
}
