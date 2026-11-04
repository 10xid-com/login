import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {sql} from 'drizzle-orm';
const state=vi.hoisted(()=>({database:null as ReturnType<typeof drizzle>|null}));
vi.mock('@/lib/db/connection',()=>({
 db:{execute:(query:unknown)=>state.database!.execute(query as Parameters<ReturnType<typeof drizzle>['execute']>[0])},
 inOwnerTransaction:(org:string,user:string,fn:(tx:unknown)=>unknown)=>state.database!.transaction(async tx=>{
  await tx.execute(sql`select set_config('app.org_id',${org},true),set_config('app.user_id',${user},true),set_config('app.is_staff','off',true)`);return fn(tx);
 }),
}));
import {publicCid,editableCid,saveCid} from '@/lib/db/cid-profiles';
import {emptyProfile,validateProfile,mayEditCid,validateActions} from '@/lib/cid/profile';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const A=id(1),B=id(2),OWNER=id(10),VIEWER=id(11),OTHER=id(12);
let pg:PGlite;
beforeAll(async()=>{
 pg=new PGlite();await pg.waitReady;state.database=drizzle(pg);
 await pg.exec(`create role portal_app; create role portal_auth;
 create table organizations(id uuid primary key default gen_random_uuid(),name text,slug text unique,type text,deleted_at timestamptz);
 create table users(id uuid primary key,is_service boolean default false,deleted_at timestamptz);
 create table user_emails(user_id uuid,email text,is_primary boolean,verified_at timestamptz);
 create table memberships(organization_id uuid,user_id uuid,role text,updated_at timestamptz default now());
 create table permissions(organization_id uuid,user_id uuid,capability text,deny boolean default false,scope_type text,scope_id uuid,revoked_at timestamptz);
 create table audit_events(organization_id uuid,actor_user_id uuid,action text,target text);
 grant select on organizations,users,user_emails,memberships,permissions to portal_app;
 grant select,insert on audit_events to portal_app; grant update on memberships to portal_app;`);
 await pg.exec(await readFile(new URL('../drizzle/0059_cid_public_profiles.sql',import.meta.url),'utf8'));
},60000);
beforeEach(async()=>{
 await pg.exec('reset role; truncate cid_public_profiles,organizations,users,memberships,permissions,audit_events cascade;');
 await pg.query("insert into organizations(id,name,slug) values($1,'Branding Centres','branding-centres'),($2,'Workwear Toronto','workwear-toronto')",[A,B]);
 for(const user of [OWNER,VIEWER,OTHER])await pg.query('insert into users(id) values($1)',[user]);
 await pg.query("insert into memberships values($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')",[A,OWNER,VIEWER,B,OTHER]);
 for(const [slug,org] of [['brandingcentres',A],['workweartoronto',B]])
  await pg.query('insert into cid_public_profiles(slug,organization_id,profile) values($1,$2,$3::jsonb)',[slug,org,JSON.stringify(emptyProfile(slug as 'brandingcentres'))]);
 await pg.exec('set role portal_app');
});
afterAll(async()=>{await pg.close();});
describe('public CiD data and member-only editing',()=>{
 it('validates shared company Action layouts and restricts Maps links to Google',()=>{
  expect(validateActions(undefined)).toHaveLength(6);
  expect(validateActions(['phone','profile','links','website','email','address'])[0]).toBe('phone');
  expect(()=>validateActions(['phone','phone','links','website','email','address'])).toThrow();
  expect(()=>validateActions(['foreign'])).toThrow();
  expect(()=>validateProfile({...emptyProfile('rotary'),mapsUrl:'https://evil.example/location'})).toThrow();
  expect(validateProfile({...emptyProfile('rotary'),mapsUrl:'https://g.page/workweartoronto?share'}).mapsUrl).toContain('g.page');
 });
 it('connects only the exact existing organizations without changing their memberships',async()=>{
  await pg.exec('reset role');
  const before=await pg.query('select organization_id,user_id,role from memberships order by organization_id,user_id');
  await pg.exec("delete from cid_public_profiles;");
  const seed=(await readFile(new URL('../drizzle/0059_cid_public_profiles.sql',import.meta.url),'utf8')).split('--> statement-breakpoint').find(part=>part.includes('DECLARE r record'))!;
  await pg.exec(seed);await pg.exec(seed);
  const mapped=await pg.query('select slug,organization_id from cid_public_profiles order by slug');
  expect(mapped.rows).toEqual([{slug:'brandingcentres',organization_id:A},{slug:'workweartoronto',organization_id:B}]);
  expect((await pg.query('select organization_id,user_id,role from memberships order by organization_id,user_id')).rows).toEqual(before.rows);
  await pg.exec('set role portal_app');
 });
 it('reads public fields anonymously and strips unknown or hidden fields',async()=>{
  const result=await publicCid('brandingcentres');expect(result.connected).toBe(true);
  expect(Object.keys(result)).toEqual(['slug','profile','version','connected']);
  const checked=validateProfile({...emptyProfile('brandingcentres'),members:['private'],showOwnership:false,ownershipLabel:'secret'});
  expect(checked).not.toHaveProperty('members');expect(checked.ownershipLabel).toBe('');
 });
 it('denies viewers and unrelated company owners even with an unattached grant',async()=>{
  await expect(editableCid('brandingcentres',VIEWER)).rejects.toThrow('role');
  await expect(saveCid('brandingcentres',OTHER,emptyProfile('brandingcentres'),1)).rejects.toThrow('assigned member');
  await pg.exec('reset role');await pg.query("insert into permissions values($1,$2,'cid.profile.write',false,'organization',null,null)",[A,OTHER]);await pg.exec('set role portal_app');
  await expect(editableCid('brandingcentres',OTHER)).rejects.toThrow('assigned member');
 });
 it('persists authorized edits across reads, audits and rejects stale overwrites',async()=>{
  const input={...emptyProfile('brandingcentres'),phone:'416-555-0100'};
  await expect(saveCid('brandingcentres',OWNER,input,1)).resolves.toEqual({saved:true,version:2});
  expect((await publicCid('brandingcentres')).profile.phone).toBe('416-555-0100');
  expect((await pg.query('select action from audit_events')).rows).toEqual([{action:'cid.profile_published'}]);
  await expect(saveCid('brandingcentres',OWNER,input,1)).rejects.toThrow('Someone changed');
 });
 it('rechecks denies and membership removal for each save',async()=>{
  await pg.exec('reset role');await pg.query("insert into permissions values($1,$2,'cid.profile.write',true,'organization',null,null)",[A,OWNER]);await pg.exec('set role portal_app');
  await expect(saveCid('brandingcentres',OWNER,emptyProfile('brandingcentres'),1)).rejects.toThrow('role');
  await pg.exec('reset role;delete from permissions;');await pg.query('delete from memberships where user_id=$1',[OWNER]);await pg.exec('set role portal_app');
  await expect(saveCid('brandingcentres',OWNER,emptyProfile('brandingcentres'),1)).rejects.toThrow('assigned member');
 });
 it('enforces isolation and viewer restrictions directly in Postgres',async()=>{
  await pg.query("select set_config('app.org_id',$1,false),set_config('app.user_id',$2,false)",[B,OTHER]);
  expect((await pg.query("update cid_public_profiles set profile='{}' where slug='brandingcentres' returning slug")).rows).toEqual([]);
  await pg.query("select set_config('app.org_id',$1,false),set_config('app.user_id',$2,false)",[A,VIEWER]);
  expect((await pg.query("update cid_public_profiles set profile='{}' where slug='brandingcentres' returning slug")).rows).toEqual([]);
 });
 it('hides deleted companies and rejects unsafe URLs and oversized fields',async()=>{
  await pg.exec('reset role');await pg.query('update organizations set deleted_at=now() where id=$1',[A]);await pg.exec('set role portal_app');
  expect((await publicCid('brandingcentres')).connected).toBe(false);
  await expect(editableCid('brandingcentres',OWNER)).rejects.toThrow();
  expect(()=>validateProfile({...emptyProfile('rotary'),website:'javascript:alert(1)'})).toThrow();
  expect(()=>validateProfile({...emptyProfile('rotary'),logoUrl:'http://example.com/logo.png'})).toThrow();
  expect(()=>validateProfile({...emptyProfile('rotary'),displayName:'x'.repeat(101)})).toThrow();
  expect(mayEditCid('owner',[{capability:'cid.profile.write',deny:true}])).toBe(false);
 });
});
