'use server';
import {redirect} from 'next/navigation';
import {assertLoginOrigin,getLoginSession} from '@/lib/auth/login';
import {userByAuthUserId} from '@/lib/db/accounts';
import {saveCid} from '@/lib/db/cid-profiles';
import {isCidSlug,PROFILE_LIMITS} from '@/lib/cid/profile';
import {MemberError} from '@/lib/uid/member-policy';

export async function publishCid(slug:string,form:FormData){
  if(!isCidSlug(slug))throw new Error('Company not found.');
  await assertLoginOrigin();
  const back=`/auth/cid/${slug}`;
  const session=await getLoginSession();
  if(!session)redirect(`/auth/sign-in?next=${encodeURIComponent(back)}`);
  if(!session.mfaVerifiedAt)redirect(`/auth/mfa?next=${encodeURIComponent(back)}`);
  const account=await userByAuthUserId(session.user.id);
  if(!account)redirect(`/auth/access?next=${encodeURIComponent(back)}`);
  const input={...Object.fromEntries(Object.keys(PROFILE_LIMITS).map(key=>[key,form.get(key)])),actions:form.getAll('actions'),showOwnership:form.get('showOwnership')==='on'};
  try{await saveCid(slug,account.id,input,Number(form.get('version')));}
  catch(error){
    const reason=error instanceof MemberError?(error.status===409?'conflict':error.status===422?'invalid':'denied'):'unavailable';
    redirect(`${back}?error=${reason}`);
  }
  redirect(`${back}?saved=1`);
}
