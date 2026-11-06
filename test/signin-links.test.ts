import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {sql} from 'drizzle-orm';

// Isolated in-memory PostgreSQL. Runs migrations 0062-0065 itself; no production connection.
const state=vi.hoisted(()=>({database:null as ReturnType<typeof drizzle>|null}));
vi.mock('@/lib/db/auth-connection',()=>({
 authDb:()=>({execute:async(query:unknown)=>{await state.database!.execute(sql`set role portal_auth`);try{return await state.database!.execute(query as Parameters<ReturnType<typeof drizzle>['execute']>[0]);}finally{await state.database!.execute(sql`set role portal_app`);}}}),
}));
vi.mock('@/lib/db/connection',()=>({
 db:{execute:(query:unknown)=>state.database!.execute(query as Parameters<ReturnType<typeof drizzle>['execute']>[0])},
 inOwnerTransaction:(organizationId:string,userId:string,fn:(tx:unknown)=>unknown)=>state.database!.transaction(async tx=>{
  await tx.execute(sql`select set_config('app.org_id',${organizationId},true),set_config('app.user_id',${userId},true),set_config('app.is_staff','off',true)`);return fn(tx);
 }),
 inAuthenticationTransaction:(fn:(tx:unknown)=>unknown)=>state.database!.transaction(async tx=>{
  await tx.execute(sql`select set_config('app.authenticating','on',true)`);return fn(tx);
 }),
}));
import * as lib from '@/lib/db/signin-links';
import {linksFor} from '@/lib/db/signin-links';
import {uidOverview,uidMembers,uidChangeMember,verifiedDiscovery,type UidActor} from '@/lib/db/uid-members';
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
// The server action attests the fresh TOTP right before each mutation; these helpers do the same.
const {hashLinkCode,newLinkCode,pairHasLinkHistory}=lib;
const start=async(sid:string,side:'initiator'|'redeemer',to='two@example.com')=>{await lib.attestFreshTotp(sid,'start');return lib.startSigninLink(sid,side,to);};
const complete=async(sid:string,code:string)=>{await lib.attestFreshTotp(sid,'complete');return lib.completeSigninLink(sid,code);};
const revoke=async(sid:string,linkId:string)=>{await lib.attestFreshTotp(sid,'revoke');return lib.revokeSigninLink(sid,linkId);};
const emailOf=(sid:string)=>su(async()=>String(((await pg.query('select e.email from auth_sessions s join users u on u.auth_user_id=s.user_id join user_emails e on e.user_id=u.id where s.id=$1',[sid])).rows[0] as {email?:string}|undefined)?.email));
async function asAuth<T>(fn:()=>Promise<T>):Promise<T>{await pg.exec('reset role;set role portal_auth');try{return await fn();}finally{await pg.exec('reset role;set role portal_app');}}
async function link(a='s1',b='s2'){
 const started=await start(a,'initiator',await emailOf(b));if(!started.ok)throw new Error(started.reason);
 return {code:started.code,result:await complete(b,started.code)};
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
  create table auth_users(id text primary key,name text default '',email text unique not null,email_verified boolean not null default false);
  create table identity_bindings(id uuid default gen_random_uuid(),user_id uuid,auth_user_id text,decision text);
  create table uid_inventory_owners(organization_id uuid,tool text,owner_user_id uuid);
  grant select,insert,update,delete on organizations,users,user_emails,memberships,permissions,invitations,uid_inventory_owners to portal_app;
  grant select,insert on audit_events to portal_app;grant usage,select on sequence audit_events_id_seq to portal_app;
 `);
 await pg.exec(await readFile(new URL('../drizzle/0062_verified_signin_links.sql',import.meta.url),'utf8'));
 await pg.exec(await readFile(new URL('../drizzle/0063_signin_link_pair_history.sql',import.meta.url),'utf8'));
 await pg.exec(await readFile(new URL('../drizzle/0064_signin_link_hardening.sql',import.meta.url),'utf8'));
 await pg.exec(await readFile(new URL('../drizzle/0065_signin_link_email_proof.sql',import.meta.url),'utf8'));
},60000);
beforeEach(async()=>{
 await pg.exec(`reset role;truncate auth_users,signin_link_attestations,signin_link_audit,signin_links,signin_link_challenges,signin_link_failures,auth_sessions,identity_bindings,uid_inventory_owners,permissions,invitations,memberships,user_emails,users,organizations cascade;`);
 await pg.query(`insert into organizations(id,name,slug) values($1,'Alpha','alpha'),($2,'Beta','beta')`,[ORG1,ORG2]);
 await pg.query(`insert into users(id,email,full_name,auth_user_id,is_service,deleted_at) values
  ($1,'one@example.com','One','a1',false,null),($2,'two@example.com','Two','a2',false,null),($3,'three@example.com','Three','a3',false,null),
  ($4,'svc@example.com','Svc','a4',true,null),($5,'gone@example.com','Gone','a5',false,now())`,[U1,U2,U3,SVC,GONE]);
 await pg.query(`insert into memberships(organization_id,user_id,role) values($1,$2,'owner'),($3,$4,'viewer')`,[ORG1,U1,ORG2,U2]);
 await pg.query(`insert into user_emails(user_id,email) values($1,'one@example.com'),($2,'two@example.com'),($3,'three@example.com')`,[U1,U2,U3]);
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
  await session('old','a1',6);expect(await start('old','initiator')).toEqual({ok:false,reason:'not_fresh'});
  await session('nomfa','a1',null);expect(await start('nomfa','initiator')).toEqual({ok:false,reason:'not_fresh'});
  expect(await start('missing','initiator')).toEqual({ok:false,reason:'not_fresh'});
  const started=await start('s1','initiator');if(!started.ok)throw new Error();
  await session('s2','a2',6);expect(await complete('s2',started.code)).toBe('not_fresh');
  await session('s2','a2',0,-1);expect(await complete('s2',started.code)).toBe('not_fresh');
  expect(await linksFor(U1)).toEqual([]);
 });
 it('refuses the same account, from a second session of it',async()=>{
  await session('s1b','a1');
  const started=await start('s1','initiator');if(!started.ok)throw new Error();
  expect(await complete('s1b',started.code)).toBe('invalid');
  expect(await linksFor(U1)).toEqual([]);
 });
 it('is single use and expires',async()=>{
  const first=await link();expect(first.result).toBe('linked');
  expect(await complete('s3',first.code)).toBe('invalid');
  await su(()=>pg.exec('update signin_links set revoked_at=now()'));
  const started=await start('s1','initiator');if(!started.ok)throw new Error();
  await su(()=>pg.exec("update signin_link_challenges set expires_at=now()-interval '1 second' where closed_at is null"));
  expect(await complete('s2',started.code)).toBe('invalid');
 });
 it('is bound to the initiating session: signing it out kills the challenge',async()=>{
  const started=await start('s1','initiator');if(!started.ok)throw new Error();
  await su(()=>pg.exec("delete from auth_sessions where id='s1'"));
  expect(await complete('s2',started.code)).toBe('invalid');
  expect(await linksFor(U2)).toEqual([]);
 });
 it('supersedes an earlier open challenge from the same account',async()=>{
  const a=await start('s1','initiator'),b=await start('s1','initiator');
  if(!a.ok||!b.ok)throw new Error();
  expect(await complete('s2',a.code)).toBe('invalid');
  await su(()=>pg.exec('delete from signin_link_failures'));
  expect(await complete('s2',b.code)).toBe('linked');
 });
 it('locks guessing after five misses, even for the right code',async()=>{
  const started=await start('s1','initiator');if(!started.ok)throw new Error();
  for(let i=0;i<5;i++)expect(await complete('s2',newLinkCode())).toBe('invalid');
  expect(await complete('s2',started.code)).toBe('locked');
 });
 it('rejects service, deleted and unsettled-identity accounts and malformed hashes',async()=>{
  await session('svc','a4');await session('gone','a5');
  expect(await start('svc','initiator')).toEqual({ok:false,reason:'not_fresh'});
  expect(await start('gone','initiator')).toEqual({ok:false,reason:'not_fresh'});
  await su(()=>pg.query("insert into identity_bindings(user_id,auth_user_id) values($1,'zz')",[U2]));
  const started=await start('s1','initiator');if(!started.ok)throw new Error();
  expect(await complete('s2',started.code)).toBe('unsettled');
  expect((await asAuth(()=>pg.query("select signin_link_start('s1','nothex','initiator','two@example.com') as r"))).rows[0]).toEqual({r:'invalid'});
 });
 it('refuses a duplicate pair and caps links per account at five',async()=>{
  expect((await link()).result).toBe('linked');
  expect((await link('s2','s1')).result).toBe('exists');
  for(let n=10;n<14;n++){
   await su(()=>pg.query('insert into users(id,email,auth_user_id) values($1,$2,$3)',[id(n),`x${n}@example.com`,`ax${n}`]));
   await su(()=>pg.query('insert into user_emails(user_id,email) values($1,$2)',[id(n),`x${n}@example.com`]));
   await session(`sx${n}`,`ax${n}`);expect((await link('s1',`sx${n}`)).result).toBe('linked');
  }
  expect(await start('s1','initiator')).toEqual({ok:false,reason:'limit'});
 });
 it('does not make links transitive',async()=>{
  await link('s1','s2');await link('s2','s3');
  expect((await linksFor(U1)).map(l=>l.userId)).toEqual([U2]);
  expect((await linksFor(U3)).map(l=>l.userId)).toEqual([U2]);
 });
 it('permanently revokes a link whose sign-in id changed; restoring it never revives the link',async()=>{
  await link();
  await su(()=>pg.query("update users set auth_user_id='rebound' where id=$1",[U2]));
  expect(await linksFor(U1)).toEqual([]);
  await su(()=>pg.query("update users set auth_user_id='a2' where id=$1",[U2]));
  expect(await linksFor(U1)).toEqual([]);
  expect(await su(async()=>(await pg.query('select revoked_at is not null as r from signin_links')).rows)).toEqual([{r:true}]);
  const actions=await su(async()=>(await pg.query('select action from signin_link_audit order by id')).rows.map(r=>(r as {action:string}).action));
  expect(actions).toContain('link.revoked_invalid');
  expect(await pairHasLinkHistory(U1,U2)).toBe(true);
 });
 it('permanently revokes when an account is deleted or becomes a service account, even if restored',async()=>{
  await link();
  await su(()=>pg.query('update users set deleted_at=now() where id=$1',[U2]));
  await su(()=>pg.query('update users set deleted_at=null where id=$1',[U2]));
  expect(await linksFor(U1)).toEqual([]);
  expect((await link('s1','s3')).result).toBe('linked');
  await su(()=>pg.query('update users set is_service=true where id=$1',[U3]));
  await su(()=>pg.query('update users set is_service=false where id=$1',[U3]));
  expect(await linksFor(U1)).toEqual([]);
 });
});

describe('recipient binding and authorization boundaries',()=>{
 it('only the intended recipient account can redeem; another MFA account holding the code is refused',async()=>{
  const started=await start('s1','initiator','two@example.com');if(!started.ok)throw new Error();
  expect(await complete('s3',started.code)).toBe('invalid');
  expect(await linksFor(U1)).toEqual([]);
  await su(()=>pg.exec('delete from signin_link_failures'));
  expect(await complete('s2',started.code)).toBe('linked');
 });
 it('an unknown or unverified recipient looks identical at start but can never be redeemed',async()=>{
  await su(()=>pg.exec("update user_emails set verified_at=null where email='three@example.com'"));
  for(const to of ['nobody@example.com','three@example.com']){
   const started=await start('s1','initiator',to);
   expect(started.ok).toBe(true);if(!started.ok)continue;
   for(const sid of ['s2','s3'])expect(await complete(sid,started.code)).toBe('invalid');
   await su(()=>pg.exec('delete from signin_link_failures'));
  }
  expect(await linksFor(U1)).toEqual([]);
 });
 it('rejects the initiator own address, and a recipient address that lost verification before redeeming',async()=>{
  const own=await start('s1','initiator','one@example.com');if(!own.ok)throw new Error();
  expect(await complete('s2',own.code)).toBe('invalid');
  await su(()=>pg.exec('delete from signin_link_failures'));
  const started=await start('s1','initiator','two@example.com');if(!started.ok)throw new Error();
  await su(()=>pg.exec("update user_emails set verified_at=null where email='two@example.com'"));
  expect(await complete('s2',started.code)).toBe('invalid');
 });
 it('refuses a mutation without a single-use attestation, even with an ordinary fresh session id',async()=>{
  expect(await lib.startSigninLink('s1','initiator','two@example.com')).toEqual({ok:false,reason:'not_fresh'});
  await lib.attestFreshTotp('s1','start');
  expect((await lib.startSigninLink('s1','initiator','two@example.com')).ok).toBe(true);
  expect(await lib.startSigninLink('s1','initiator','two@example.com')).toEqual({ok:false,reason:'not_fresh'});
  const started=await start('s1','initiator');if(!started.ok)throw new Error();
  await lib.attestFreshTotp('s2','start');
  expect(await lib.completeSigninLink('s2',started.code)).toBe('not_fresh');
 });
 it('rejects a stale TOTP at attest, an expired attestation, and an mfa timestamp that moved',async()=>{
  await session('old','a1',2);expect(await lib.attestFreshTotp('old','start')).toBe(false);
  expect(await lib.attestFreshTotp('s1','start')).toBe(true);
  await su(()=>pg.exec("update signin_link_attestations set expires_at=now()-interval '1 second'"));
  expect(await lib.startSigninLink('s1','initiator','two@example.com')).toEqual({ok:false,reason:'not_fresh'});
  expect(await lib.attestFreshTotp('s1','start')).toBe(true);
  await su(()=>pg.exec("update auth_sessions set mfa_verified_at=mfa_verified_at+interval '1 second' where id='s1'"));
  expect(await lib.startSigninLink('s1','initiator','two@example.com')).toEqual({ok:false,reason:'not_fresh'});
 });
 it('enforces initiator proof freshness at completion',async()=>{
  const started=await start('s1','initiator');if(!started.ok)throw new Error();
  await session('s1','a1',6);
  expect(await complete('s2',started.code)).toBe('invalid');
  await su(()=>pg.exec('delete from signin_link_failures'));
  await session('s1','a1',0);
  await su(()=>pg.exec("update signin_link_challenges set initiator_proof_at=now()-interval '6 minutes'"));
  expect(await complete('s2',started.code)).toBe('invalid');
  expect(await linksFor(U1)).toEqual([]);
 });
 it('denies the app role every link function; discovery without a live MFA session is empty',async()=>{
  const h='a'.repeat(64);
  for(const q of ["select signin_link_attest('s1','start')",`select signin_link_start('s1','${h}','initiator','two@example.com')`,`select signin_link_complete('s2','${h}')`,`select signin_links_for('${U1}')`,"select signin_link_consume('s1','start')",`select signin_link_sweep('${U1}')`])
   await expect(pg.query(q)).rejects.toThrow('permission denied');
  await link();
  await session('s1','a1',null);await session('s2','a2',null);
  expect(await linksFor(U1)).toEqual([]);
  await expect(pg.query('select * from signin_link_attestations')).rejects.toThrow('permission denied');
 });
 it('handles a reverse duplicate gracefully and rechecks the recipient cap at completion',async()=>{
  expect((await link('s1','s2')).result).toBe('linked');
  const reverse=await start('s2','initiator','one@example.com');if(!reverse.ok)throw new Error();
  expect(await complete('s1',reverse.code)).toBe('exists');
  const late=await start('s1','initiator','three@example.com');if(!late.ok)throw new Error();
  for(let n=20;n<25;n++){
   await su(()=>pg.query('insert into users(id,email,auth_user_id) values($1,$2,$3)',[id(n),`y${n}@example.com`,`ay${n}`]));
   await su(()=>pg.query("insert into signin_links(user_low,user_high,auth_user_low,auth_user_high,primary_user_id,initiator_user_id) values($1,$2,'a3',$3,$1,$1)",[U3,id(n),`ay${n}`]));
  }
  expect(await complete('s3',late.code)).toBe('limit');
  expect((await linksFor(U1)).map(x=>x.userId)).toEqual([U2]);
 });
 it('does not revive a revoked link after the binding changes back',async()=>{
  await link();const [l]=await linksFor(U1);await revoke('s1',l.linkId);
  await su(()=>pg.query("update users set auth_user_id='rebound' where id=$1",[U2]));
  await su(()=>pg.query("update users set auth_user_id='a2' where id=$1",[U2]));
  expect(await linksFor(U1)).toEqual([]);
  expect(await pairHasLinkHistory(U1,U2)).toBe(true);
 });
});

describe('verified address: portal alias or the bound Better Auth address (0065)',()=>{
 const authUser=(aid:string,mail:string,verified:boolean)=>su(()=>pg.query('insert into auth_users(id,email,email_verified) values($1,$2,$3) on conflict(id) do update set email=excluded.email,email_verified=excluded.email_verified',[aid,mail,verified]));
 const aliasUnverified=(mail:string)=>su(()=>pg.query('update user_emails set verified_at=null where lower(email)=$1',[mail]));
 // Rana as modeled after 0047: the portal alias is unverified, the bound Better Auth identity is verified.
 const rana=async()=>{
  await su(()=>pg.query("update users set email='samay@example.com' where id=$1",[U2]));
  await su(()=>pg.query("update user_emails set email='samay@example.com',verified_at=null where user_id=$1",[U2]));
  await authUser('a2','samay@example.com',true);
 };
 it('links when the alias is unverified but the exact bound Better Auth address is verified (Rana)',async()=>{
  await rana();
  const started=await start('s1','initiator','Samay@Example.com ');if(!started.ok)throw new Error();
  expect(await complete('s2',started.code)).toBe('linked');
  expect((await linksFor(U1)).map(l=>l.userId)).toEqual([U2]);
 });
 it('still links on a verified alias alone, and needs one of the two proofs',async()=>{
  await authUser('a2','two@example.com',false);
  expect((await link()).result).toBe('linked');
  await su(()=>pg.exec('update signin_links set revoked_at=now()'));
  await aliasUnverified('two@example.com');
  const started=await start('s1','initiator','two@example.com');if(!started.ok)throw new Error();
  expect(await complete('s2',started.code)).toBe('invalid');
 });
 it('does not count an unverified identity, an unbound identity, or an identity bound to another account',async()=>{
  await rana();await authUser('a2','samay@example.com',false);
  let started=await start('s1','initiator','samay@example.com');if(!started.ok)throw new Error();
  expect(await complete('s2',started.code)).toBe('invalid');
  await su(()=>pg.exec('delete from signin_link_failures'));
  await authUser('a2','samay@example.com',true);await authUser('zz','stray@example.com',true);
  started=await start('s1','initiator','stray@example.com');if(!started.ok)throw new Error();
  expect(await complete('s2',started.code)).toBe('invalid');
  // a2 is verified for samay@, but that address is not on U3 (bound to a3)
  await su(()=>pg.exec('delete from signin_link_failures'));
  started=await start('s1','initiator','samay@example.com');if(!started.ok)throw new Error();
  expect(await complete('s3',started.code)).toBe('invalid');
 });
 it('refuses a conflicting match: two accounts claim the address (alias vs Better Auth, or alias vs alias)',async()=>{
  await rana();
  // U3 also holds a (verified) alias on Rana's verified Better Auth address.
  await su(()=>pg.query("insert into user_emails(user_id,email) values($1,'samay@example.com')",[U3]));
  let started=await start('s1','initiator','samay@example.com');if(!started.ok)throw new Error();
  for(const sid of ['s2','s3'])expect(await complete(sid,started.code)).toBe('invalid');
  await su(()=>pg.exec('delete from signin_link_failures'));
  // alias vs alias, one of them unverified: still ambiguous.
  await su(()=>pg.query("insert into user_emails(user_id,email) values($1,'two@example.com')",[U2]));
  await su(()=>pg.query("insert into user_emails(user_id,email,verified_at) values($1,'two@example.com',null)",[U3]));
  started=await start('s1','initiator','two@example.com');if(!started.ok)throw new Error();
  for(const sid of ['s2','s3'])expect(await complete(sid,started.code)).toBe('invalid');
  expect(await linksFor(U1)).toEqual([]);
 });
 it('rechecks the identical condition on redeem: an address claimed or unverified after start fails',async()=>{
  await rana();
  let started=await start('s1','initiator','samay@example.com');if(!started.ok)throw new Error();
  await authUser('a2','samay@example.com',false);
  expect(await complete('s2',started.code)).toBe('invalid');
  await su(()=>pg.exec('delete from signin_link_failures'));
  await authUser('a2','samay@example.com',true);
  started=await start('s1','initiator','samay@example.com');if(!started.ok)throw new Error();
  await su(()=>pg.query("insert into user_emails(user_id,email,verified_at) values($1,'samay@example.com',null)",[U3]));
  expect(await complete('s2',started.code)).toBe('invalid');
  expect(await linksFor(U1)).toEqual([]);
 });
 it('fails safely on stale or rebound proof: rebind, deletion, signed-out or expired sessions',async()=>{
  await rana();
  const open=async()=>{await su(()=>pg.exec('delete from signin_link_failures'));const s=await start('s1','initiator','samay@example.com');if(!s.ok)throw new Error();return s.code;};
  let code=await open();
  await su(()=>pg.query("update users set auth_user_id='a2b' where id=$1",[U2]));
  await session('s2b','a2b');
  expect(await complete('s2',code)).toBe('not_fresh');
  expect(await complete('s2b',code)).toBe('invalid');
  await su(()=>pg.query("update users set auth_user_id='a2' where id=$1",[U2]));
  code=await open();
  await su(()=>pg.exec("delete from auth_sessions where id='s1'"));
  expect(await complete('s2',code)).toBe('invalid');
  await session('s1','a1');code=await open();
  await session('s1','a1',6);
  expect(await complete('s2',code)).toBe('invalid');
  await session('s1','a1');code=await open();
  await session('s2','a2',0,-1);
  expect(await complete('s2',code)).toBe('not_fresh');
  await session('s2','a2');code=await open();
  await su(()=>pg.exec("update signin_link_challenges set expires_at=now()-interval '1 second' where closed_at is null"));
  expect(await complete('s2',code)).toBe('invalid');
  await session('s1','a1');code=await open();
  await su(()=>pg.query('update users set deleted_at=now() where id=$1',[U1]));
  expect(await complete('s2',code)).toBe('invalid');
  expect(await linksFor(U2)).toEqual([]);
 });
 it('judges proof by wall-clock time, so a long lock wait inside one transaction cannot extend it',async()=>{
  await session('soon','a1',0,0.01);
  const inside=await su(()=>pg.transaction(async tx=>{
   const before=(await tx.query("select count(*)::int as n from signin_link_proof('soon',300)")).rows[0] as {n:number};
   await tx.query('select pg_sleep(1.2)');
   const after=(await tx.query("select count(*)::int as n from signin_link_proof('soon',300)")).rows[0] as {n:number};
   return [before.n,after.n];
  }));
  expect(inside).toEqual([1,0]);
 });
});

describe('primary sign-in, revoke and audit',()=>{
 it('records the chosen primary and exposes it to both sides',async()=>{
  const started=await start('s1','redeemer');if(!started.ok)throw new Error();
  await complete('s2',started.code);
  expect((await linksFor(U1))[0].primary).toBe(true);
  expect((await linksFor(U2))[0].primary).toBe(false);
  expect((await uidOverview(actor(U1,'one@example.com'))).signIn.current.primary).toBe(false);
  expect((await uidOverview(actor(U2,'two@example.com'))).signIn.current.primary).toBe(true);
 });
 it('lets either side revoke from a fresh session; a stranger cannot',async()=>{
  await link();const [l]=await linksFor(U1);
  expect(await revoke('s3',l.linkId)).toBe('not_found');
  await session('s2','a2',6);expect(await revoke('s2',l.linkId)).toBe('not_fresh');
  await session('s2','a2',0);expect(await revoke('s2',l.linkId)).toBe('revoked');
  expect(await linksFor(U1)).toEqual([]);expect(await revoke('s2',l.linkId)).toBe('not_found');
  expect((await link()).result).toBe('linked');
 });
 it('keeps an append-only audit and gives the app role no direct table access',async()=>{
  await link();const [l]=await linksFor(U1);await revoke('s1',l.linkId);
  const actions=await su(async()=>(await pg.query('select action from signin_link_audit order by id')).rows.map(r=>(r as {action:string}).action));
  expect(actions).toEqual(['challenge.started','link.created','link.revoked']);
  await expect(su(()=>pg.exec("update signin_link_audit set action='x'"))).rejects.toThrow('append-only');
  await expect(pg.query('select * from signin_links')).rejects.toThrow('permission denied');
  await expect(pg.query("insert into signin_links(user_low,user_high,auth_user_low,auth_user_high,primary_user_id,initiator_user_id) values($1,$2,'a','b',$1,$1)",[U1,U2])).rejects.toThrow('permission denied');
  await expect(pg.query('select * from signin_link_challenges')).rejects.toThrow('permission denied');
 });
 it('stores only a hash of the code',async()=>{
  const started=await start('s1','initiator');if(!started.ok)throw new Error();
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
  await link();const [l]=await linksFor(U1);await revoke('s1',l.linkId);
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

 const legacyPair=async()=>{
  await su(async()=>{
   await pg.query("insert into users(id,email,full_name,auth_user_id) values($1,'r1@example.com','R1','r1'),($2,'r2@example.com','R2','r2')",[R1,R2]);
   await pg.query("insert into memberships(organization_id,user_id,role) values($1,$2,'owner')",[ORG2,R2]);
   await pg.query("insert into user_emails(user_id,email) values($1,'r1@example.com'),($2,'r2@example.com')",[R1,R2]);
  });
  await session("sr1","r1");await session("sr2","r2");
 };
 it("does not resurrect the legacy fallback after an explicit verified link is revoked",async()=>{
  await legacyPair();
  const r1=actor(R1,"r1@example.com");
  expect((await uidOverview(r1,R2)).linkedMemberships.map(m=>m.source)).toEqual(["legacy"]);
  expect((await link("sr1","sr2")).result).toBe("linked");
  expect((await uidOverview(r1,R2)).linkedMemberships.map(m=>m.source)).toEqual(["verified"]);
  const [l]=await linksFor(R1);
  expect(await revoke("sr1",l.linkId)).toBe("revoked");
  expect(await pairHasLinkHistory(R1,R2)).toBe(true);
  expect((await uidOverview(r1,R2)).linkedMemberships).toEqual([]);
  expect((await uidOverview(actor(R2,"r2@example.com"),R1)).linkedMemberships).toEqual([]);
 });
 it("reports no pair history for accounts that never linked",async()=>{
  expect(await pairHasLinkHistory(U1,U3)).toBe(false);
 });
});

describe("account page discovery data",()=>{
 it("lists active links with the partner memberships, display only, and drops revoked ones",async()=>{
  await link();
  const d=await verifiedDiscovery(U1);
  expect(d).toHaveLength(1);
  expect(d[0].link.email).toBe("two@example.com");
  expect(d[0].memberships).toEqual([{id:ORG2,name:"Beta",roleLabel:expect.any(String)}]);
  expect(await verifiedDiscovery(U3)).toEqual([]);
  await revoke("s1",d[0].link.linkId);
  expect(await verifiedDiscovery(U1)).toEqual([]);
 });
});
