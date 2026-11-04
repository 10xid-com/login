import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, inAuthenticationTransaction, inOwnerTransaction, type Transaction } from "./connection";
import { ROLES, ROLE_LABELS, CLOTHING_CAPABILITIES, isRole, managesMembers, mayChange, clothingLevel, MemberError } from "@/lib/uid/member-policy";

export type UidActor = { userId: string; email: string; name: string; addresses: string[] };
type MemberRow = { user_id: string; name: string; email: string; role: string; updated_at: Date | string };
type Grant = { id: string; capability: string; deny: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function businessId(input: unknown): string {
  if (typeof input !== "string" || !UUID.test(input)) throw new MemberError("Choose a business Channel.", 422);
  return input;
}
async function rows<T>(tx: Transaction, query: Parameters<Transaction["execute"]>[0]): Promise<T[]> {
  return (await tx.execute(query)).rows as T[];
}
async function scope(tx: Transaction, actor: UidActor, organizationId: string) {
  const [member] = await rows<{ role: string; name: string; slug: string; member_visibility: string }>(tx, sql`
    select m.role::text, o.name, o.slug, o.member_visibility::text from memberships m
    join organizations o on o.id=m.organization_id and o.deleted_at is null
    join users u on u.id=m.user_id and u.deleted_at is null and not u.is_service
    where m.organization_id=${organizationId}::uuid and m.user_id=${actor.userId}::uuid
    for update of m`);
  if (!member || !isRole(member.role)) throw new MemberError("You do not have access to this business Channel.");
  return member;
}
async function grants(tx: Transaction, organizationId: string, userId: string): Promise<Grant[]> {
  return rows<Grant>(tx, sql`select id::text,capability,deny from permissions where organization_id=${organizationId}::uuid
    and user_id=${userId}::uuid and scope_type='organization' and scope_id is null and revoked_at is null
    and capability in ('clothing.read','clothing.write','clothing.publish') order by id`);
}
function version(member: MemberRow, permissions: Grant[]): string {
  return createHash("sha256").update(JSON.stringify([member.role, new Date(member.updated_at).toISOString(), permissions])).digest("hex");
}
async function audit(tx: Transaction, organizationId: string, actor: UidActor, action: string, target: string) {
  await tx.execute(sql`insert into audit_events(organization_id,actor_user_id,action,target)
    values(${organizationId}::uuid,${actor.userId}::uuid,${action},${target})`);
}
async function lock(tx: Transaction, organizationId: string) {
  // Shared by every UiD management write. Row locks also serialize against the existing portal's role editor.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('memberships_owner:' || ${organizationId},0))`);
}
export function clothingConfiguredFor(slug: string): boolean {
  return slug === (process.env.CLOTHING_BUSINESS_SLUG || "tbox-studio") &&
    Boolean(process.env.CLOTHING_API_URL && (process.env.CLOTHING_API_KEY || "").length >= 32);
}
export async function uidOverview(actor: UidActor) {
  const memberships = await db.execute(sql`select o.id::text,o.name,o.slug,m.role::text from memberships m
    join organizations o on o.id=m.organization_id and o.deleted_at is null where m.user_id=${actor.userId}::uuid order by o.name,o.id`);
  const businesses = [];
  for (const entry of memberships.rows) {
    if (!isRole(entry.role)) continue;
    const id = String(entry.id), role = String(entry.role);
    const access = await inOwnerTransaction(id,actor.userId,async tx => {
      const level=clothingLevel(role,await grants(tx,id,actor.userId));
      const ownership=await rows<{tool:'inventory'|'clothing';owned_by_you:boolean}>(tx,sql`
        select tool,owner_user_id=${actor.userId}::uuid as owned_by_you
        from uid_inventory_owners where organization_id=${id}::uuid`);
      return {level,ownership:Object.fromEntries(ownership.map(item=>[item.tool,item.owned_by_you]))};
    });
    businesses.push({ id, name: String(entry.name), role, roleLabel: ROLE_LABELS[entry.role], canManage: managesMembers(role),
      inventoryOwnership:{inventory:access.ownership.inventory===true,clothing:access.ownership.clothing===true},
      tools: { clothing: { available: clothingConfiguredFor(String(entry.slug)), level:access.level } } });
  }
  // Invitation discovery is SELECT-only, by this verified account's exact addresses.
  const incoming = await inAuthenticationTransaction(tx => rows(tx,sql`select i.id::text,i.organization_id::text as business_id,
    o.name as business_name,i.email,i.role::text,i.expires_at from invitations i join organizations o on o.id=i.organization_id
    where i.email in (${sql.join(actor.addresses.map(address=>sql`${address}`),sql`, `)})
    and i.accepted_at is null and i.revoked_at is null and i.expires_at>now() and o.deleted_at is null order by i.created_at desc`));
  return { actor: { id: actor.userId, name: actor.name, email: actor.email }, businesses, incoming,
    roles: ROLES.map(value=>({value,label:ROLE_LABELS[value]})) };
}
export async function uidMembers(actor: UidActor, organizationId: string) {
  return inOwnerTransaction(organizationId,actor.userId,async tx=>{
    const actorMembership=await scope(tx,actor,organizationId);
    const manage=managesMembers(actorMembership.role);
    const members=await rows<MemberRow>(tx,sql`select u.id::text as user_id,coalesce(u.full_name,u.email) as name,u.email,m.role::text,m.updated_at
      from memberships m join users u on u.id=m.user_id and u.deleted_at is null and not u.is_service
      where m.organization_id=${organizationId}::uuid
      ${manage || actorMembership.member_visibility==='open' ? sql`` : sql`and u.id=${actor.userId}::uuid`}
      order by (m.role='owner') desc,lower(coalesce(u.full_name,u.email)),u.id`);
    const result=[];
    for(const member of members){
      const permissionRows=await grants(tx,organizationId,member.user_id);
      result.push({id:member.user_id,name:member.name,email:member.email,role:member.role,
        clothing:clothingLevel(member.role,permissionRows),version:version(member,permissionRows),
        canEdit:manage&&(actorMembership.role==='owner'||member.role!=='owner')});
    }
    const pending=manage?await rows(tx,sql`select id::text,email,role::text,expires_at,created_at from invitations
      where organization_id=${organizationId}::uuid and accepted_at is null and revoked_at is null order by created_at desc`):[];
    const actorLevel=clothingLevel(actorMembership.role,await grants(tx,organizationId,actor.userId));
    return {business:{id:organizationId,name:actorMembership.name},role:actorMembership.role,canManage:manage,
      directoryVisible:manage||actorMembership.member_visibility==='open',members:result,pending,
      clothingAvailable:clothingConfiguredFor(actorMembership.slug),maxClothing:actorLevel};
  });
}
export async function uidChangeMember(actor: UidActor, organizationId: string, input: {userId:string;role:string;clothing:number;version:string;remove?:boolean}) {
  businessId(input.userId);
  if(!isRole(input.role)||!Number.isInteger(input.clothing)||input.clothing<0||input.clothing>3||typeof input.version!=='string')
    throw new MemberError("Choose a valid role and tool access.",422);
  return inOwnerTransaction(organizationId,actor.userId,async tx=>{
    await lock(tx,organizationId);
    const actorMembership=await scope(tx,actor,organizationId);
    const [member]=await rows<MemberRow>(tx,sql`select u.id::text as user_id,coalesce(u.full_name,u.email) as name,u.email,m.role::text,m.updated_at
      from memberships m join users u on u.id=m.user_id and u.deleted_at is null and not u.is_service
      where m.organization_id=${organizationId}::uuid and m.user_id=${input.userId}::uuid for update of m`);
    if(!member)throw new MemberError("This member is no longer in the business.",404);
    if(!mayChange(actorMembership.role,member.role,input.role))throw new MemberError("Only an owner can change an owner's membership or appoint an owner.");
    const oldGrants=await grants(tx,organizationId,input.userId);
    if(version(member,oldGrants)!==input.version)throw new MemberError("This member changed on another device. Refresh Members and try again.",409);
    const oldLevel=clothingLevel(member.role,oldGrants);
    if(!input.remove&&input.role==='owner'&&input.clothing!==3&&clothingConfiguredFor(actorMembership.slug))
      throw new MemberError("Owners retain full tool access. Choose another role to limit access.",422);
    if(!input.remove&&input.clothing!==oldLevel){
      if(!clothingConfiguredFor(actorMembership.slug))throw new MemberError("Clothing Inventory is not connected to this business.",422);
      const ownLevel=clothingLevel(actorMembership.role,await grants(tx,organizationId,actor.userId));
      if(actorMembership.role!=='owner'&&input.clothing>ownLevel)throw new MemberError("You cannot grant tool access beyond your own access.");
    }
    if(member.role==='owner'&&(input.remove||input.role!=='owner')){
      const [count]=await rows<{n:number}>(tx,sql`select count(*)::int as n from memberships m join users u on u.id=m.user_id
        where m.organization_id=${organizationId}::uuid and m.role='owner' and u.deleted_at is null and not u.is_service`);
      if(count.n<=1)throw new MemberError("The business must keep at least one owner.",409);
    }
    if(input.remove){
      await tx.execute(sql`delete from memberships where organization_id=${organizationId}::uuid and user_id=${input.userId}::uuid`);
      // A later re-invitation must not resurrect access awarded to a former membership.
      await tx.execute(sql`update permissions set revoked_at=now() where organization_id=${organizationId}::uuid
        and user_id=${input.userId}::uuid and revoked_at is null and capability in ('clothing.read','clothing.write','clothing.publish')`);
      await audit(tx,organizationId,actor,'membership.removed',input.userId);
    }else{
      await tx.execute(sql`update memberships set role=${input.role}::membership_role,updated_at=now()
        where organization_id=${organizationId}::uuid and user_id=${input.userId}::uuid`);
      if((input.clothing!==oldLevel||input.role!==member.role)&&(clothingConfiguredFor(actorMembership.slug)||oldGrants.length)){
        await tx.execute(sql`update permissions set revoked_at=now() where organization_id=${organizationId}::uuid
          and user_id=${input.userId}::uuid and scope_type='organization' and scope_id is null and revoked_at is null
          and capability in ('clothing.read','clothing.write','clothing.publish')`);
        if(input.role!=='owner')for(const capability of CLOTHING_CAPABILITIES.slice(0,input.clothing))
          await tx.execute(sql`insert into permissions(organization_id,user_id,capability,scope_type,granted_by)
            values(${organizationId}::uuid,${input.userId}::uuid,${capability},'organization',${actor.userId}::uuid)`);
      }
      await audit(tx,organizationId,actor,'membership.role_and_tools_changed',JSON.stringify({userId:input.userId,from:member.role,to:input.role,clothing:input.clothing}));
    }
    return {saved:true};
  });
}
export async function uidInvite(actor: UidActor, organizationId: string, input:{email:string;role:string}) {
  const email=String(input.email||'').trim().toLowerCase();
  if(email.length>320||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!isRole(input.role))throw new MemberError("Enter a valid email address and role.",422);
  return inOwnerTransaction(organizationId,actor.userId,async tx=>{
    await lock(tx,organizationId);const membership=await scope(tx,actor,organizationId);
    if(!mayChange(membership.role,'viewer',input.role))throw new MemberError("You cannot invite someone with that role.");
    const existing=await rows(tx,sql`select 1 from memberships m join users u on u.id=m.user_id
      join user_emails e on e.user_id=u.id and (e.is_primary or e.verified_at is not null)
      where m.organization_id=${organizationId}::uuid and e.email=${email} and u.deleted_at is null`);
    if(existing.length)throw new MemberError("This person is already a member. Edit their membership instead.",409);
    const [ownerInvite]=await rows(tx,sql`select 1 from invitations where organization_id=${organizationId}::uuid and email=${email}
      and role='owner' and accepted_at is null and revoked_at is null`);
    if(ownerInvite&&membership.role!=='owner')throw new MemberError("Only an owner can replace this invitation.");
    await tx.execute(sql`update invitations set revoked_at=now() where organization_id=${organizationId}::uuid and email=${email}
      and accepted_at is null and revoked_at is null`);
    const [invitation]=await rows<{id:string}>(tx,sql`insert into invitations(organization_id,email,role,invited_by,expires_at)
      values(${organizationId}::uuid,${email},${input.role}::membership_role,${actor.userId}::uuid,now()+interval '7 days') returning id::text`);
    await audit(tx,organizationId,actor,'membership.invited',JSON.stringify({invitationId:invitation.id,email,role:input.role}));
    return {id:invitation.id,email,businessName:membership.name};
  });
}
export async function uidRevokeInvite(actor: UidActor, organizationId:string, invitationId:string){
  businessId(invitationId);
  return inOwnerTransaction(organizationId,actor.userId,async tx=>{
    await lock(tx,organizationId);const membership=await scope(tx,actor,organizationId);
    const [invitation]=await rows<{role:string}>(tx,sql`select role::text from invitations where id=${invitationId}::uuid
      and organization_id=${organizationId}::uuid and accepted_at is null and revoked_at is null for update`);
    if(!invitation)throw new MemberError("This invitation is no longer pending.",404);
    if(!mayChange(membership.role,invitation.role,'viewer'))throw new MemberError("You cannot withdraw this invitation.");
    await tx.execute(sql`update invitations set revoked_at=now() where id=${invitationId}::uuid and organization_id=${organizationId}::uuid`);
    await audit(tx,organizationId,actor,'membership.invitation_revoked',invitationId);return {saved:true};
  });
}
export async function uidAcceptInvite(actor:UidActor,organizationId:string,invitationId:string,decline=false){
  businessId(invitationId);
  return inOwnerTransaction(organizationId,actor.userId,async tx=>{
    await lock(tx,organizationId);
    const [invitation]=await rows<{role:string}>(tx,sql`select i.role::text from invitations i join organizations o on o.id=i.organization_id
      where i.id=${invitationId}::uuid and i.organization_id=${organizationId}::uuid and i.accepted_at is null and i.revoked_at is null
      and i.expires_at>now() and o.deleted_at is null
      and i.email in (${sql.join(actor.addresses.map(address=>sql`${address}`),sql`, `)}) for update of i`);
    if(!invitation||!isRole(invitation.role))throw new MemberError("This invitation is unavailable or belongs to another account.",404);
    if(decline)await tx.execute(sql`update invitations set revoked_at=now() where id=${invitationId}::uuid`);
    else{
      // An invitation adds a missing membership; accepting one never overwrites an existing role.
      await tx.execute(sql`insert into memberships(organization_id,user_id,role) values(${organizationId}::uuid,${actor.userId}::uuid,${invitation.role}::membership_role)
        on conflict(user_id,organization_id) do nothing`);
      await tx.execute(sql`update invitations set accepted_at=now() where id=${invitationId}::uuid`);
    }
    await audit(tx,organizationId,actor,decline?'membership.invitation_declined':'membership.invitation_accepted',invitationId);return {saved:true};
  });
}
export async function uidClothingAccess(actor:UidActor,organizationId?:string){
  const target=organizationId?businessId(organizationId):null;
  const found=await db.execute(sql`select id::text from organizations where slug=${process.env.CLOTHING_BUSINESS_SLUG||'tbox-studio'}
    and deleted_at is null ${target?sql`and id=${target}::uuid`:sql``}`);
  if(found.rows.length!==1)throw new MemberError("Clothing Inventory is not connected to this business.",404);
  const id=String(found.rows[0].id);
  return inOwnerTransaction(id,actor.userId,async tx=>{
    const membership=await scope(tx,actor,id);
    if(!clothingConfiguredFor(membership.slug))throw new MemberError("Clothing Inventory is not connected yet.",503);
    return {id,level:clothingLevel(membership.role,await grants(tx,id,actor.userId))};
  });
}
