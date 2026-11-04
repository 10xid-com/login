import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {sql} from 'drizzle-orm';

// Real PostgreSQL semantics in an isolated in-memory database. No production connection is used.
const state=vi.hoisted(()=>({database:null as ReturnType<typeof drizzle>|null}));
vi.mock('@/lib/db/connection',()=>({
 db:{execute:(query:unknown)=>state.database!.execute(query as Parameters<ReturnType<typeof drizzle>['execute']>[0])},
 inOwnerTransaction:(organizationId:string,userId:string,fn:(tx:unknown)=>unknown)=>state.database!.transaction(async tx=>{
  await tx.execute(sql`select set_config('app.org_id',${organizationId},true),set_config('app.user_id',${userId},true),set_config('app.is_staff','off',true)`);return fn(tx);
 }),
 inAuthenticationTransaction:(fn:(tx:unknown)=>unknown)=>state.database!.transaction(async tx=>{
  await tx.execute(sql`select set_config('app.authenticating','on',true)`);return fn(tx);
 }),
}));
import {uidOverview,uidMembers,uidChangeMember,uidInvite,uidAcceptInvite,uidClothingAccess,type UidActor} from '@/lib/db/uid-members';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const A=id(1),B=id(2),OWNER=id(10),EDITOR=id(11),VIEWER=id(12),OTHER=id(13),MANAGER=id(14);
const actor=(userId:string,email:string):UidActor=>({userId,email,name:email,addresses:[email]});
const owner=actor(OWNER,'owner@example.com'),editor=actor(EDITOR,'editor@example.com'),viewer=actor(VIEWER,'viewer@example.com'),other=actor(OTHER,'other@example.com'),manager=actor(MANAGER,'manager@example.com');
let pg:PGlite;
beforeAll(async()=>{
 pg=new PGlite();await pg.waitReady;state.database=drizzle(pg);
 await pg.exec(`
  create role portal_app; create role portal_auth;
  create type membership_role as enum('owner','manager','editor','publisher','asset_manager','viewer','member','staff');
  create table organizations(id uuid primary key,name text,slug text unique,type text default 'client',member_visibility text default 'closed',deleted_at timestamptz);
  create table users(id uuid primary key,email text,full_name text,is_service boolean default false,deleted_at timestamptz);
  create table user_emails(user_id uuid references users,email text,is_primary boolean default true,verified_at timestamptz default now());
  create table memberships(id uuid default gen_random_uuid(),organization_id uuid references organizations,user_id uuid references users,role membership_role,updated_at timestamptz default now(),unique(user_id,organization_id));
  create table permissions(id uuid default gen_random_uuid(),organization_id uuid references organizations,user_id uuid references users,capability text,scope_type text,scope_id uuid,deny boolean default false,granted_by uuid references users,revoked_at timestamptz);
  create table invitations(id uuid default gen_random_uuid(),organization_id uuid references organizations,email text,role membership_role,invited_by uuid references users,expires_at timestamptz,accepted_at timestamptz,revoked_at timestamptz,created_at timestamptz default now());
  create table audit_events(id bigserial,organization_id uuid references organizations,actor_user_id uuid references users,action text,target text);
  alter table permissions enable row level security;
  alter table invitations enable row level security;
  alter table audit_events enable row level security;
  create policy permission_tenant on permissions to portal_app using(organization_id=nullif(current_setting('app.org_id',true),'')::uuid) with check(organization_id=nullif(current_setting('app.org_id',true),'')::uuid);
  create policy invitation_tenant on invitations to portal_app using(organization_id=nullif(current_setting('app.org_id',true),'')::uuid) with check(organization_id=nullif(current_setting('app.org_id',true),'')::uuid);
  create policy invitation_auth on invitations for select to portal_app using(current_setting('app.authenticating',true)='on');
  create policy audit_tenant on audit_events to portal_app using(organization_id=nullif(current_setting('app.org_id',true),'')::uuid) with check(organization_id=nullif(current_setting('app.org_id',true),'')::uuid);
  grant select,insert,update,delete on organizations,users,user_emails,memberships,permissions,invitations to portal_app;
  grant select,insert on audit_events to portal_app;grant usage,select on sequence audit_events_id_seq to portal_app;
 `);
 process.env.CLOTHING_BUSINESS_SLUG='tbox-studio';process.env.CLOTHING_API_URL='https://clothing.example.com';process.env.CLOTHING_API_KEY='x'.repeat(40);
},60000);
beforeEach(async()=>{
 await pg.exec(`reset role;truncate audit_events,permissions,invitations,memberships,user_emails,users,organizations restart identity cascade;`);
 await pg.query(`insert into organizations(id,name,slug) values($1,'TBox Studio','tbox-studio'),($2,'Other business','other')`,[A,B]);
 for(const [who,name] of [[owner,'Owner'],[editor,'Editor'],[viewer,'Viewer'],[other,'Other'],[manager,'Manager']] as const){
  await pg.query('insert into users(id,email,full_name) values($1,$2,$3)',[who.userId,who.email,name]);
  await pg.query('insert into user_emails(user_id,email) values($1,$2)',[who.userId,who.email]);
 }
 for(const [org,userId,role] of [[A,OWNER,'owner'],[A,EDITOR,'editor'],[A,VIEWER,'viewer'],[A,MANAGER,'manager'],[B,OTHER,'owner']])
  await pg.query('insert into memberships(organization_id,user_id,role) values($1,$2,$3)',[org,userId,role]);
 await pg.exec('set role portal_app');
});
afterAll(async()=>{await pg.close();});
async function member(userId:string){return (await uidMembers(owner,A)).members.find(m=>m.id===userId)!;}
describe('central Members data and authorization as a restricted role',()=>{
 it('uses the restricted role and shows only entitled business Channels',async()=>{
  expect((await pg.query<{current_user:string}>('select current_user')).rows[0].current_user).toBe('portal_app');
  const overview=await uidOverview(owner);expect(overview.businesses.map(b=>b.id)).toEqual([A]);
  await expect(uidMembers(owner,B)).rejects.toThrow('do not have access');
  await expect(uidChangeMember(other,A,{userId:VIEWER,role:'owner',clothing:3,version:'fake'})).rejects.toThrow('do not have access');
 });
 it('respects a closed member directory for ordinary members',async()=>{
  const response=await uidMembers(viewer,A);expect(response.members.map(m=>m.id)).toEqual([VIEWER]);expect(response.pending).toEqual([]);
  expect(response.members[0].canEdit).toBe(false);
 });
 it('grants explicit inventory access, saves centrally and rejects stale edits',async()=>{
  const before=await member(VIEWER);
  await uidChangeMember(owner,A,{userId:VIEWER,role:'viewer',clothing:1,version:before.version});
  expect((await uidClothingAccess(viewer,A)).level).toBe(1);
  await expect(uidChangeMember(owner,A,{userId:VIEWER,role:'editor',clothing:2,version:before.version})).rejects.toThrow('changed on another device');
  expect((await uidMembers(viewer,A)).members[0].role).toBe('viewer');
 });
 it('does not let a manager promote an owner or grant access beyond their own',async()=>{
  const target=await member(VIEWER);
  await expect(uidChangeMember(manager,A,{userId:VIEWER,role:'owner',clothing:3,version:target.version})).rejects.toThrow('Only an owner');
  await expect(uidChangeMember(manager,A,{userId:VIEWER,role:'viewer',clothing:2,version:target.version})).rejects.toThrow('beyond your own');
 });
 it('keeps the last owner',async()=>{
  const target=await member(OWNER);
  await expect(uidChangeMember(owner,A,{userId:OWNER,role:'viewer',clothing:0,version:target.version,remove:true})).rejects.toThrow('at least one owner');
 });
 it('revokes inventory access immediately and does not resurrect grants on rejoining',async()=>{
  let target=await member(EDITOR);await uidChangeMember(owner,A,{userId:EDITOR,role:'editor',clothing:3,version:target.version});
  expect((await uidClothingAccess(editor,A)).level).toBe(3);
  target=await member(EDITOR);await uidChangeMember(owner,A,{userId:EDITOR,role:'editor',clothing:3,version:target.version,remove:true});
  await expect(uidClothingAccess(editor,A)).rejects.toThrow('do not have access');
  const invite=await uidInvite(owner,A,{email:editor.email,role:'viewer'});await uidAcceptInvite(editor,A,invite.id);
  expect((await uidClothingAccess(editor,A)).level).toBe(0);
 });
 it('lets the exact recipient accept once from another UiD, without exposing a different business',async()=>{
  const invitation=await uidInvite(owner,A,{email:other.email,role:'editor'});
  expect((await uidOverview(other)).incoming).toHaveLength(1);
  await expect(uidAcceptInvite(viewer,A,invitation.id)).rejects.toThrow('belongs to another account');
  await uidAcceptInvite(other,A,invitation.id);
  expect((await uidOverview(other)).businesses.map(b=>b.id).sort()).toEqual([A,B].sort());
  await expect(uidAcceptInvite(other,A,invitation.id)).rejects.toThrow('unavailable');
  expect((await uidClothingAccess(other,A)).level).toBe(0);
 });
 it('enforces tenant policies under the restricted role outside a business transaction',async()=>{
  const target=await member(VIEWER);await uidChangeMember(owner,A,{userId:VIEWER,role:'viewer',clothing:1,version:target.version});
  expect((await pg.query('select * from permissions')).rows).toEqual([]);
  expect((await pg.query('select * from audit_events')).rows).toEqual([]);
 });
 it('repairs only the named existing legacy TBox owner and is idempotent',async()=>{
  await pg.exec('reset role');
  await pg.query("update user_emails set email='paolo@tboxstudio.com' where user_id=$1",[OWNER]);
  await pg.query("update memberships set role='staff' where user_id=$1 and organization_id=$2",[OWNER,A]);
  const migration=await readFile(new URL('../drizzle/0056_tbox_member_management.sql',import.meta.url),'utf8');
  await pg.exec(migration);await pg.exec(migration);
  const role=(await pg.query<{role:string}>('select role from memberships where user_id=$1 and organization_id=$2',[OWNER,A])).rows[0].role;
  expect(role).toBe('owner');
  expect((await pg.query('select * from audit_events')).rows).toHaveLength(1);
  expect((await pg.query<{role:string}>('select role from memberships where user_id=$1 and organization_id=$2',[VIEWER,A])).rows[0].role).toBe('viewer');
 });
});
