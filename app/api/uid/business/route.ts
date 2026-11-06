import { authenticateUid } from "@/lib/uid/authenticate";
import { MemberError, requiredClothingLevel } from "@/lib/uid/member-policy";
import { clothingProxy } from "@/lib/uid/clothing-proxy";
import { sendInvitation } from "@/lib/auth/mailer";
import { businessId, uidOverview, uidMembers, uidChangeMember, uidInvite, uidRevokeInvite, uidAcceptInvite, uidClothingAccess } from "@/lib/db/uid-members";

export const runtime='nodejs';
const HEADERS={'cache-control':'no-store','x-content-type-options':'nosniff'};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:HEADERS});
async function boundedJson(request:Request){
  if(Number(request.headers.get('content-length'))>8*1024*1024)throw new MemberError('Request too large.',413);
  const reader=request.body?.getReader();if(!reader)throw new MemberError('Invalid request.',400);
  const chunks:Uint8Array[]=[];let length=0;
  while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;
    if(length>8*1024*1024){await reader.cancel();throw new MemberError('Request too large.',413);}chunks.push(part.value);}
  try{return JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>;}catch{throw new MemberError('Invalid request.',400);}
}
/** Machine endpoint: every operation revalidates the live person and their business membership. */
export async function POST(request:Request){
  try{
    const input=await boundedJson(request);
    if(!input||typeof input!=='object'||Array.isArray(input))throw new MemberError('Invalid request.',400);
    const actor=await authenticateUid(request.headers.get('authorization'),input);
    const action=input.action;
    if(action==='overview')return json(await uidOverview(actor));
    if(action==='clothing-authorize'){
      const access=await uidClothingAccess(actor,typeof input.business==='string'?input.business:undefined);
      if(!['GET','POST'].includes(String(input.method))||input.path!=='/api/clothing/photo-reader'||
        access.level<requiredClothingLevel(String(input.method),String(input.path)))throw new MemberError('Your role does not allow this Clothing Inventory action.');
      return json({allowed:true});
    }
    if(action==='clothing')return await clothingProxy(actor,input as Parameters<typeof clothingProxy>[1]);
    const business=businessId(input.business);
    if(action==='members'){
      const roster=await uidMembers(actor,business);
      if(input.host!=='uid-rana.10xid.com'&&input.host!=='uid-ethan.10xid.com')return json(roster);
      let phones:Record<string,string>={};
      try{phones=JSON.parse(process.env.CONTACT_DIRECTORY_PHONES||'{}')||{};}catch{/* Optional contact data. */}
      const members=roster.members.map(member=>{
        const phone=phones[member.id];
        const primary=member.id==='bbb11aae-61de-4bdf-ae62-6be722ba9ab4';
        const rana=primary||member.id==='0145e895-4ea1-4d73-b692-e2b07c883875';
        return {...member,...(typeof phone==='string'&&/^\d{3}-\d{3}-\d{4}$/.test(phone)?{contactPhone:phone}:{}),
          ...(rana?{contactGroup:{key:'rana',name:'Rana',primary}}:{})};
      });
      return json({...roster,members});
    }
    if(action==='change'||action==='remove'){
      const data=input.member as Parameters<typeof uidChangeMember>[2];
      if(!data||typeof data!=='object')throw new MemberError('Select a member.',422);
      return json(await uidChangeMember(actor,business,{...data,remove:action==='remove'}));
    }
    if(action==='invite'){
      const data=input.invitation as {email:string;role:string};
      if(!data||typeof data!=='object')throw new MemberError('Enter the invitation details.',422);
      const invitation=await uidInvite(actor,business,data);
      let delivered=true;
      try{await sendInvitation({to:invitation.email,organizationName:invitation.businessName,invitedByEmail:actor.email,
        signUpUrl:`https://${process.env.PRIMARY_HOST||'login.10xid.com'}/auth/sign-in`});}
      catch{delivered=false;console.error('[uid-members] invitation saved; notification delivery failed');}
      return json({saved:true,delivered});
    }
    if(action==='revoke')return json(await uidRevokeInvite(actor,business,String(input.invitationId||'')));
    if(action==='accept'||action==='decline')return json(await uidAcceptInvite(actor,business,String(input.invitationId||''),action==='decline'));
    return json({error:'Unknown member action.'},422);
  }catch(error){
    if(error instanceof MemberError)return json({error:error.message},error.status);
    console.error('[uid-members] request failed',error instanceof Error?error.name:'unknown');
    return json({error:'Members could not be loaded or saved. Please try again.'},503);
  }
}
