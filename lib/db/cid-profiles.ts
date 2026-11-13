import 'server-only';
import {sql} from 'drizzle-orm';
import {db,inOwnerTransaction} from './connection';
import {CID_COMPANIES,emptyProfile,mayEditCid,validateProfile,type CidSlug} from '@/lib/cid/profile';
import {MemberError} from '@/lib/uid/member-policy';

export async function publicCid(slug:CidSlug){
  const result=await db.execute(sql`select p.profile,p.version from cid_public_profiles p
    join organizations o on o.id=p.organization_id and o.deleted_at is null where p.slug=${slug}`);
  const row=result.rows[0];
  return {slug,profile:row?validateProfile(row.profile):emptyProfile(slug),version:row?Number(row.version):0,connected:Boolean(row)};
}
/** A live, assigned membership is mandatory, even with an explicit capability grant. */
type CidTransaction = Parameters<Parameters<typeof inOwnerTransaction>[2]>[0];

async function memberRole(tx:CidTransaction,slug:CidSlug,userId:string){
  const result=await tx.execute(sql`select m.role::text from memberships m join users u on u.id=m.user_id
    and u.deleted_at is null and not u.is_service join organizations o on o.id=m.organization_id and o.deleted_at is null
    where m.organization_id=nullif(current_setting('app.org_id',true),'')::uuid and o.slug=${CID_COMPANIES[slug].organizationSlug} and m.user_id=${userId}::uuid for update of m`);
  return result.rows[0]?.role;
}

async function mayEditProfile(tx:CidTransaction,userId:string,role:string){
  const grants=await tx.execute(sql`select capability,deny from permissions where organization_id=nullif(current_setting('app.org_id',true),'')::uuid
    and user_id=${userId}::uuid and capability='cid.profile.write' and scope_type='organization' and scope_id is null and revoked_at is null`);
  return mayEditCid(role,grants.rows as {capability:string;deny:boolean}[]);
}

async function memberAccess(tx:CidTransaction,slug:CidSlug,userId:string){
  const role=await memberRole(tx,slug,userId);
  if(typeof role!=='string')throw new MemberError('You are not an assigned member of this company.');
  if(!await mayEditProfile(tx,userId,role))throw new MemberError('Your company role does not allow profile editing.');
}
async function organization(slug:CidSlug){
  const result=await db.execute(sql`select organization_id::text as id from cid_public_profiles where slug=${slug}`);
  const id=result.rows[0]?.id;
  if(typeof id!=='string')throw new MemberError('This company profile has not been connected to its account yet.',409);
  return id;
}
export async function cidWorkspaceAccess(slug:CidSlug,userId:string){
  const id=await organization(slug);
  return inOwnerTransaction(id,userId,async tx=>{
    const role=await memberRole(tx,slug,userId);
    if(typeof role!=='string')return {canEdit:false,canViewWorkDecks:false};
    return {canEdit:await mayEditProfile(tx,userId,role),canViewWorkDecks:true};
  });
}

export async function editableCid(slug:CidSlug,userId:string){
  const id=await organization(slug);
  return inOwnerTransaction(id,userId,async tx=>{
    await memberAccess(tx,slug,userId);
    const result=await tx.execute(sql`select profile,version from cid_public_profiles where slug=${slug} and organization_id=${id}::uuid`);
    if(!result.rows[0])throw new MemberError('Company profile unavailable.',404);
    return {profile:validateProfile(result.rows[0].profile),version:Number(result.rows[0].version)};
  });
}
export async function saveCid(slug:CidSlug,userId:string,input:unknown,version:number){
  let profile;try{profile=validateProfile(input);}catch(error){throw new MemberError(error instanceof Error?error.message:'Check the profile.',422);}
  if(!Number.isSafeInteger(version)||version<1)throw new MemberError('Reload this profile before saving.',409);
  const id=await organization(slug);
  return inOwnerTransaction(id,userId,async tx=>{
    // Same lock as membership management: a concurrent removal wins before the next save.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('memberships_owner:' || ${id},0))`);
    await memberAccess(tx,slug,userId);
    const changed=await tx.execute(sql`update cid_public_profiles set profile=${JSON.stringify(profile)}::jsonb,
      version=version+1,updated_at=now(),updated_by=${userId}::uuid where slug=${slug} and organization_id=${id}::uuid and version=${version} returning version`);
    if(!changed.rows.length)throw new MemberError('Someone changed this profile. Reload before saving your changes.',409);
    await tx.execute(sql`insert into audit_events(organization_id,actor_user_id,action,target)
      values(${id}::uuid,${userId}::uuid,'cid.profile_published',${slug})`);
    return {saved:true,version:Number(changed.rows[0].version)};
  });
}
