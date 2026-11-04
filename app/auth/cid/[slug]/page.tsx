import {redirect,notFound} from 'next/navigation';
import {getLoginSession} from '@/lib/auth/login';
import {userByAuthUserId} from '@/lib/db/accounts';
import {editableCid} from '@/lib/db/cid-profiles';
import {CID_COMPANIES,isCidSlug,cidUrl,PROFILE_LIMITS} from '@/lib/cid/profile';
import {MemberError} from '@/lib/uid/member-policy';
import {publishCid} from './actions';
import {ActionPicker} from './action-picker';
import {AuthCard,inputClass,labelClass} from '../../auth-card';
export const dynamic='force-dynamic';
const LABELS:Record<keyof typeof PROFILE_LIMITS,string>={displayName:'Display name',description:'About the company',website:'Website',email:'Public contact email',phone:'Public phone',address:'Public address',instagram:'Instagram',facebook:'Facebook',linkedin:'LinkedIn',ownershipLabel:'Ownership label',logoUrl:'Logo image URL (HTTPS)',mapsUrl:'Google Maps location URL'};
export default async function CidEditor({params,searchParams}:{params:Promise<{slug:string}>;searchParams:Promise<{saved?:string;error?:string}>}){
  const {slug}=await params;if(!isCidSlug(slug))notFound();
  const back=`/auth/cid/${slug}`,session=await getLoginSession();
  if(!session)redirect(`/auth/sign-in?next=${encodeURIComponent(back)}`);
  if(!session.mfaVerifiedAt)redirect(`/auth/mfa?next=${encodeURIComponent(back)}`);
  const account=await userByAuthUserId(session.user.id);
  if(!account)redirect(cidUrl(slug));
  let data;
  try{data=await editableCid(slug,account.id);}catch(error){
    if(error instanceof MemberError && error.status===403)redirect(cidUrl(slug));
    return <AuthCard title={CID_COMPANIES[slug].name} intro="Company profile"><p role="alert">{error instanceof MemberError?error.message:'The company profile is temporarily unavailable.'}</p><p><a href={cidUrl(slug)}>View public CiD →</a></p><p><a href="/auth/account">Account settings</a></p></AuthCard>;
  }
  const query=await searchParams;
  const errors:Record<string,string>={conflict:'This profile changed or is not connected. Reload before saving again.',invalid:'Check the profile fields and website links.',denied:'Your account no longer has permission to edit this company.',unavailable:'The profile could not be saved. Please try again.'};
  return <AuthCard title={CID_COMPANIES[slug].name} intro="Edit public company identity">
    <p>Signed in as {session.user.email}. Everything saved in this form is public. Members, jobs, tasks and customer information stay private.</p>
    {query.saved==='1'&&<p role="status">Company profile published. Changes are now shared across devices.</p>}
    {query.error&&<p role="alert">{errors[query.error]||'The profile could not be saved.'}</p>}
    <form action={publishCid.bind(null,slug)} className="space-y-4">
      <input type="hidden" name="version" value={data.version}/>
      <ActionPicker initial={data.profile.actions}/>
      {Object.entries(PROFILE_LIMITS).map(([field,max])=><label key={field} className={labelClass}>{LABELS[field as keyof typeof LABELS]}
        {['description','address'].includes(field)?<textarea name={field} defaultValue={data.profile[field as keyof typeof PROFILE_LIMITS]} maxLength={max} rows={3} className={inputClass}/>:<input name={field} defaultValue={data.profile[field as keyof typeof PROFILE_LIMITS]} maxLength={max} required={field==='displayName'} type={field==='email'?'email':['website','instagram','facebook','linkedin','logoUrl','mapsUrl'].includes(field)?'url':'text'} className={inputClass}/>}
      </label>)}
      <label className={labelClass}><input name="showOwnership" type="checkbox" defaultChecked={data.profile.showOwnership}/> Display the ownership label publicly</label>
      <button type="submit" className="rounded-lg bg-slate-100 px-4 py-3 text-slate-950">Publish company profile</button>
    </form><p><a href={cidUrl(slug)}>View public CiD →</a></p>
  </AuthCard>;
}
