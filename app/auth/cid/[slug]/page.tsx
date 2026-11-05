import type {ReactNode} from "react";
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
export default async function CidEditor({params,searchParams}:{params:Promise<{slug:string}>;searchParams:Promise<{saved?:string;error?:string;stage?:string}>}){
  const {slug}=await params;if(!isCidSlug(slug))notFound();
  const query=await searchParams;
  const inStage=query.stage==='1';
  const back=`/auth/cid/${slug}`;
  const title=CID_COMPANIES[slug].name;
  const message=(text:string)=><section className="p-4"><h1 className="text-lg font-semibold">Edit CiD</h1><p role="status" className="mt-2">{text}</p></section>;
  const session=await getLoginSession();
  if(inStage&&!session?.mfaVerifiedAt)return message('Sign in to 10XiD with your authenticator to edit this company.');
  if(!session)redirect(`/auth/sign-in?next=${encodeURIComponent(back)}`);
  if(!session.mfaVerifiedAt)redirect(`/auth/mfa?next=${encodeURIComponent(back)}`);
  const account=await userByAuthUserId(session.user.id);
  if(!account){
    if(inStage)return message('Company editing access is required.');
    redirect(cidUrl(slug));
  }
  let data;
  try{data=await editableCid(slug,account.id);}catch(error){
    if(inStage)return message(error instanceof MemberError?error.message:'The company profile is temporarily unavailable.');
    if(error instanceof MemberError && error.status===403)redirect(cidUrl(slug));
    return <AuthCard title={CID_COMPANIES[slug].name} intro="Company profile"><p role="alert">{error instanceof MemberError?error.message:'The company profile is temporarily unavailable.'}</p><p><a href={cidUrl(slug)+'?view=public'}>View public CiD →</a></p><p><a href="/auth/account">Account settings</a></p></AuthCard>;
  }
  const errors:Record<string,string>={conflict:'This profile changed or is not connected. Reload before saving again.',invalid:'Check the profile fields and website links.',denied:'Your account no longer has permission to edit this company.',unavailable:'The profile could not be saved. Please try again.'};
  const wrap=(children:ReactNode)=>inStage
    ? <section className="mx-auto w-full max-w-2xl space-y-4 px-3 py-4 sm:px-6"><h1 className="text-xl font-semibold text-ink">Edit CiD</h1>{children}</section>
    : <AuthCard title={title} intro="Edit public company identity">{children}</AuthCard>;
  return wrap(<>
    <p>Signed in as {session.user.email}. Everything saved in this form is public. Members, jobs, tasks and customer information stay private.</p>
    {query.saved==='1'&&<p role="status">Company profile published. Changes are now shared across devices.</p>}
    {query.error&&<p role="alert">{errors[query.error]||'The profile could not be saved.'}</p>}
    {!inStage&&<p><a href={`/auth/cid/${slug}/blogs`}>Blog Posts →</a></p>}
    <form action={publishCid.bind(null,slug)} className="space-y-4">
      {inStage&&<input type="hidden" name="stage" value="1"/>}
      <input type="hidden" name="version" value={data.version}/>
      <ActionPicker initial={data.profile.actions}/>
      {Object.entries(PROFILE_LIMITS).map(([field,max])=><label key={field} className={labelClass}>{LABELS[field as keyof typeof LABELS]}
        {['description','address'].includes(field)?<textarea name={field} defaultValue={data.profile[field as keyof typeof PROFILE_LIMITS]} maxLength={max} rows={3} className={inputClass}/>:<input name={field} defaultValue={data.profile[field as keyof typeof PROFILE_LIMITS]} maxLength={max} required={field==='displayName'} type={field==='email'?'email':['website','instagram','facebook','linkedin','logoUrl','mapsUrl'].includes(field)?'url':'text'} className={inputClass}/>}
      </label>)}
      <label className={labelClass}><input name="showOwnership" type="checkbox" defaultChecked={data.profile.showOwnership}/> Display the ownership label publicly</label>
      <button type="submit" className="rounded-lg bg-slate-100 px-4 py-3 text-slate-950">Publish company profile</button>
    </form>{!inStage&&<p><a href={cidUrl(slug)+'?view=public'}>View public CiD →</a></p>}
  </>);
}
