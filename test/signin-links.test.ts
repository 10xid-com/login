import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {sql} from 'drizzle-orm';

// Isolated in-memory PostgreSQL. Runs migration 0062 itself; no production connection.
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
import {startSigninLink,completeSigninLink,revokeSigninLink,linksFor,hashLinkCode,newLinkCode} from '@/lib/db/signin-links';
import {uidOverview,uidMembers,uidChangeMember,type UidActor} from '@/lib/db/uid-members';
import {legacyLinkedAccount,LEGACY_RANA_ACCOUNTS} from '@/lib/uid/legacy-rana-compat';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const U1=id(1),U2=id(2),U3=id(3),SVC=id(4),GONE=id(5),ORG1=id(100),ORG2=id(101);
const actor=(userId:string,email:string):UidActor=>({userId,email,name:email,addresses:[email]});
let pg:PGlite;
async function su<T>(fn:()=>Promise<T>):Promise<T>{await pg.exec('reset role');try{return await fn();}finally{await pg.exec('set role portal_app');}}
async function session(sid:string,authId:string,minutesAgo:number|null=0,expiresInMin=60){
 await su(()=>pg.query(
  `insert into auth_sessions(id,user_id,expires_at,mfa_verified_at) values($1,$2,now()+($3||' minutes')::interval,${minutesAgo===null?'null':"now()-($4||' minutes')::interval"})
   on conflict(id) do update set mfa_verified_at=excluded.mfa_verified_at,expires_at=excluded.expires_at`,
  minutesAgo===null?[sid,authId,String(expiresInMin)]:[sid,authId,String(expiresInMin),String(minutesAgo)]));
}
async function link(a='s1',b='s2'){
 const started=await startSigninLink(a,'initiator');if(!started.ok)throw new Error(started.reason);
 return {code:started.code,result:await completeSigninLink(b,started.code)};
}
beforeAll(async()=>{
 pg=new PGlite();await pg.waitReady;state.database=drizzle(pg);
 await pg.exec(`
  create role portal_app; create role portal_auth;
  create type membership_role as enum('owner','manager','editor','publisher','asset_manager','viewer','member','staff');
  create table organizations(id uuid primary key,name text,slug text unique,type text default 'client',member_visibility text default 'closed',deleted_at timestamptz);
  create table users(id uuid primary key,email text,full_name text,auth_user_id text,is_service boolean default false,deleted_at timestamptz);
  create table user_emails(user_id uuid references users,email text,is_primary boolean default true,verified_at timestamptz default now());
  create table memberships(id uuid default gen_random_uuid(),organization_id uuid references organizations,user_id uuid references users,role membership_role,created_at timestamptz not null default now(),updated_at timestamptz default now(),unique(user_id,organization_id));
  create table permissions(id uuid default gen_random_uuid(),organization_id uuid references organizations,user_id uuid references users,capability text,scope_type text,scope_id uuid,deny boolean default false,granted_by uuid references users,revoked_at timestamptz);
  create table invitations(id uuid default gen_random_uuid(),organization_id uuid references organizations,email text,role membership_role,invited_by uuid references users,expires_at timestamptz,accepted_at timestamptz,revoked_at timestamptz,created_at timestamptz default now());
  create table audit_events(id bigserial,organization_id uuid references organizations,actor_user_id uuid references users,action text,target text);
  create table auth_sessions(id text primary key,user_id text not null,expires_at timestamptz not null,mfa_verified_at timestamptz);
  create table identity_bindings(id uuid default gen_random_uuid(),user_id uuid,auth_user_id text,decision text);
  create table uid_inventory_owners(organization_id uuid,tool text,owner_user_id uuid);
  grant select,insert,update,delete on organizations,users,user_emails,memberships,permissions,invitations,uid_inventory_owners to portal_app;
  grant select,insert on audit_events to portal_app;grant usage,select on sequence audit_events_id_seq to portal_app;
 `);
 await pg.exec(await readFile(new URL('../drizzle/0062_verified_signin_links.sql',import.meta.url),'utf8'));
},60000);
beforeEach(async()=>{
 await pg.exec(`reset role;truncate signin_link_audit,signin_links,signin_link_challenges,signin_link_failures,auth_sessions,identity_bindings,uid_inventory_owners,permissions,invitations,memberships,user_emails,users,organizations cascade;`);
 await pg.query(`insert into organizations(id,name,slug) values($1,'Alpha','alpha'),($2,'Beta','beta')`,[ORG1,ORG2]);
 await pg.query(`insert into users(id,email,full_name,auth_user_id,is_service,deleted_at) values
  ($1,'one@example.com','One','a1',false,null),($2,'two@example.com','Two','a2',false,null),($3,'three@example.com','Three','a3',false,null),
  ($4,'svc@example.com','Svc','a4',true,null),($5,'gone@example.com','Gone','a5',false,now())`,[U1,U2,U3,SVC,GONE]);
 await pg.query(`insert into memberships(organization_id,user_id,role) values($1,$2,'owner'),($3,$4,'viewer')`,[ORG1,U1,ORG2,U2]);
 await pg.exec('set role portal_app');
 await session('s1','a1');await session('s2','a2');await session('s3','a3');
});
afterAll(async()=>{await pg.close();});

describe('proof of both accounts',()=>{
 it('links only when the second account redeems the code from its own fresh session',async()=>{
  const {result}=await link();expect(result).toBe('linked');
  expect((await linksFor(U1)).map(l=>l.userId)).toEqual([U2]);
  expect((await linksFor(U2)).map(l=>l.userId)).toEqual([U1]);
 });
 it('refuses a start or redeem from a session without a recent authenticator check',async()=>{
  await session('old','a1',6);expect(await startSigninLink('old','initiator')).toEqual({ok:false,reason:'not_fresh'});
  await session('nomfa','a1',null);expect(await startSigninLink('nomfa','initiator')).toEqual({ok:false,reason:'no_session'});
  expect(await startSigninLink('missing','initiator')).toEqual({ok:false,reason:'no_session'});
  const started=await startSigninLink('s1','initiator');if(!started.ok)throw new Error();
  await session('s2','a2',6);expect(await completeSigninLink('s2',started.code)).toBe('not_fresh');
  await session('s2','a2',0,-1);expect(await completeSigninLink('s2',started.code)).toBe('no_session');
  expect(await linksFor(U1)).toEqual([]);
 });
 it('refuses the same account, from a second session of it',async()=>{
  await session('s1b','a1');
  const started=await startSigninLink('s1','initiator');if(!started.ok)throw new Error();
  expect(await completeSigninLink('s1b',started.code)).toBe('same_account');
  expect(await linksFor(U1)).toEqual([]);
 });
 it('is single use and expires',async()=>{
  const first=await link();expect(first.result).toBe('linked');
  expect(await completeSigninLink('s3',first.code)).toBe('invalid');
  await su(()=>pg.exec('update signin_links set revoked_at=now()'));
  const started=await startSigninLink('s1','initiator');if(!started.ok)throw new Error();
  await su(()=>pg.exec("update signin_link_challenges set expires_at=now()-interval '1 second' where closed_at is null"));
  expect(await completeSigninLink('s2',started.code)).toBe('invalid');
 });
 it('is bound to the initiating session: signing it out kills the challenge',async()=>{
  const started=await startSigninLink('s1','initiator');if(!started.ok)throw new Error();
  await su(()=>pg.exec("delete from auth_sessions where id='s1'"));
  expect(await completeSigninLink('s2',started.code)).toBe('invalid');
  expect(await linksFor(U2)).toEqual([]);
 });
 it('supersedes an earlier open challenge from the same account',async()=>{
  const a=await startSigninLink('s1','initiator'),b=await startSigninLink('s1','initiator');
  if(!a.ok||!b.ok)throw new Error();
  expect(await completeSigninLink('s2',a.code)).toBe('invalid');
  await su(()=>pg.exec('delete from signin_link_failures'));
  expect(await completeSigninLink('s2',b.code)).toBe('linked');
 });
 it('locks guessing after five misses, even for the right code',async()=>{
  const started=await startSigninLink('s1','initiator');if(!started.ok)throw new Error();
  for(let i=0;i<5;i++)expect(await completeSigninLink('s2',newLinkCode())).toBe('invalid');
  expect(await completeSigninLink('s2',started.code)).toBe('locked');
 });
 it('rejects service, deleted and unsettled-identity accounts and malformed hashes',async()=>{
  await session('svc','a4');await session('gone','a5');
  expect(await startSigninLink('svc','initiator')).toEqual({ok:false,reason:'no_session'});
  expect(await startSigninLink('gone','initiator')).toEqual({ok:false,reason:'no_session'});
  await su(()=>pg.query("insert into identity_bindings(user_id,auth_user_id) values($1,'zz')",[U2]));
  const started=await startSigninLink('s1','initiator');if(!started.ok)throw new Error();
  expect(await completeSigninLink('s2',started.code)).toBe('unsettled');
  expect((await pg.query("select signin_link_start('s1','nothex','initiator') as r")).rows[0]).toEqual({r:'invalid'});
 });
 it('refuses a duplicate pair and caps links per account at five',async()=>{
  expect((await link()).result).toBe('linked');
  expect((await link('s2','s1')).result).toBe('exists');
  for(let n=10;n<14;n++){
   await su(()=>pg.query('insert into users(id,email,auth_user_id) values($1,$2,$3)',[id(n),`x${n}@example.com`,`ax${n}`]));
   await session(`sx${n}`,`ax${n}`);expect((await link('s1',`sx${n}`)).result).toBe('linked');
  }
  expect(await startSigninLink('s1','initiator')).toEqual({ok:false,reason:'limit'});
 });
 it('does not make links transitive',async()=>{
  await link('s1','s2');await link('s2','s3');
  expect((await linksFor(U1)).map(l=>l.userId)).toEqual([U2]);
  expect((await linksFor(U3)).map(l=>l.userId)).toEqual([U2]);
 });
 it('drops a link whose sign-in id changed or whose account became deleted',async()=>{
  await link();
  await su(()=>pg.query("update users set auth_user_id='rebound' where id=$1",[U2]));
  expect(await linksFor(U1)).toEqual([]);
  await su(()=>pg.query("update users set auth_user_id='a2' where id=$1",[U2]));
  expect(await linksFor(U1)).toHaveLength(1);
  await su(()=>pg.query('update users set deleted_at=now() where id=$1',[U2]));
  expect(await linksFor(U1)).toEqual([]);
 });
});

describe('primary sign-in, revoke and audit',()=>{
 it('records the chosen primary and exposes it to both sides',async()=>{
  const started=await startSigninLink('s1','redeemer');if(!started.ok)throw new Error();
  await completeSigninLink('s2',started.code);
  expect((await linksFor(U1))[0].primary).toBe(true);
  expect((await linksFor(U2))[0].primary).toBe(false);
  expect((await uidOverview(actor(U1,'one@example.com'))).signIn.current.primary).toBe(false);
  expect((await uidOverview(actor(U2,'two@example.com'))).signIn.current.primary).toBe(true);
 });
 it('lets either side revoke from a fresh session; a stranger cannot',async()=>{
  await link();const [l]=await linksFor(U1);
  expect(await revokeSigninLink('s3',l.linkId)).toBe('not_found');
  await session('s2','a2',6);expect(await revokeSigninLink('s2',l.linkId)).toBe('not_fresh');
  await session('s2','a2',0);expect(await revokeSigninLink('s2',l.linkId)).toBe('revoked');
  expect(await linksFor(U1)).toEqual([]);expect(await revokeSigninLink('s2',l.linkId)).toBe('not_found');
  expect((await link()).result).toBe('linked');
 });
 it('keeps an append-only audit and gives the app role no direct table access',async()=>{
  await link();const [l]=await linksFor(U1);await revokeSigninLink('s1',l.linkId);
  const actions=await su(async()=>(await pg.query('select action from signin_link_audit order by id')).rows.map(r=>(r as {action:string}).action));
  expect(actions).toEqual(['challenge.started','link.created','link.revoked']);
  await expect(su(()=>pg.exec("update signin_link_audit set action='x'"))).rejects.toThrow('append-only');
  await expect(pg.query('select * from signin_links')).rejects.toThrow('permission denied');
  await expect(pg.query("insert into signin_links(user_low,user_high,auth_user_low,auth_user_high,primary_user_id,initiator_user_id) values($1,$2,'a','b',$1,$1)",[U1,U2])).rejects.toThrow('permission denied');
  await expect(pg.query('select * from signin_link_challenges')).rejects.toThrow('permission denied');
 });
 it('stores only a hash of the code',async()=>{
  const started=await startSigninLink('s1','initiator');if(!started.ok)throw new Error();
  const rows=await su(async()=>(await pg.query('select code_hash from signin_link_challenges')).rows as {code_hash:string}[]);
  expect(rows[0].code_hash).toBe(hashLinkCode(started.code));
  expect(JSON.stringify(rows)).not.toContain(started.code.replace('-',''));
  expect(hashLinkCode(started.code.toLowerCase().replace('-',' '))).toBe(rows[0].code_hash);
 });
});

describe('discovery is separate from authorization',()=>{
 const one=actor(U1,'one@example.com');
 it('shows the linked sign-in businesses as display-only rows marked verified, self-only',async()=>{
  await link();
  const o=await uidOverview(one);
  expect(o.businesses.map(b=>b.id)).toEqual([ORG1]);
  expect(o.linkedMemberships).toEqual([{id:ORG2,name:'Beta',roleLabel:expect.any(String),email:'two@example.com',source:'verified'}]);
  expect(o.signIn.alternates.map(a=>a.id)).toEqual([U2]);
  expect((await uidOverview(actor(U3,'three@example.com'))).linkedMemberships).toEqual([]);
 });
 it('never grants access to the linked account business',async()=>{
  await link();
  await expect(uidMembers(one,ORG2)).rejects.toThrow('do not have access');
  await expect(uidChangeMember(one,ORG2,{userId:U2,role:'viewer',remove:true} as never)).rejects.toThrow();
 });
 it('exposes no alias or alternate membership to a roster viewer',async()=>{
  await link();
  await su(()=>pg.query("insert into memberships(organization_id,user_id,role) values($1,$2,'viewer')",[ORG1,U3]));
  const roster=JSON.stringify(await uidMembers(actor(U3,'three@example.com'),ORG1));
  expect(roster).not.toContain('Beta');expect(roster).not.toContain('two@example.com');expect(roster).not.toContain(U2);
 });
 it('ignores a revoked link',async()=>{
  await link();const [l]=await linksFor(U1);await revokeSigninLink('s1',l.linkId);
  expect((await uidOverview(one)).linkedMemberships).toEqual([]);
 });
});

describe('legacy Rana compatibility stays narrow and unverified',()=>{
 const [R1,R2]=LEGACY_RANA_ACCOUNTS;
 it('only applies on the PiD host, only to the pair, and is never a stored link',async()=>{
  expect(legacyLinkedAccount('uid-rana.10xid.com',R1)).toBe(R2);
  expect(legacyLinkedAccount('uid-rana.10xid.com',R2)).toBe(R1);
  expect(legacyLinkedAccount('uid-ethan.10xid.com',R1)).toBeUndefined();
  expect(legacyLinkedAccount('uid-rana.10xid.com',U1)).toBeUndefined();
  expect(await su(async()=>(await pg.query('select count(*)::int as n from signin_links')).rows[0])).toEqual({n:0});
 });
 it('still displays the partner businesses, marked legacy, until a real link exists',async()=>{
  await su(async()=>{
   await pg.query("insert into users(id,email,full_name,auth_user_id) values($1,'r1@example.com','R1','r1'),($2,'r2@example.com','R2','r2')",[R1,R2]);
   await pg.query("insert into memberships(organization_id,user_id,role) values($1,$2,'owner')",[ORG2,R2]);
  });
  const o=await uidOverview(actor(R1,'r1@example.com'),R2);
  expect(o.linkedMemberships).toEqual([{id:ORG2,name:'Beta',roleLabel:expect.any(String),email:'r2@example.com',source:'legacy'}]);
  expect(o.signIn.alternates).toEqual([]);
  await expect(uidMembers(actor(R1,'r1@example.com'),ORG2)).rejects.toThrow('do not have access');
 });
});
