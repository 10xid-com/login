import {beforeAll,beforeEach,afterAll,test,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let pg:PGlite,migration:string;
const uid='00000000-0000-4000-8000-000000000010',other='00000000-0000-4000-8000-000000000011';
const tbox='00000000-0000-4000-8000-000000000001',workwear='00000000-0000-4000-8000-000000000002',rotary='00000000-0000-4000-8000-000000000003';
beforeAll(async()=>{
 pg=new PGlite();await pg.waitReady;
 await pg.exec(`create table users(id uuid primary key,auth_user_id text,is_service boolean default false,deleted_at timestamptz);
 create table user_emails(user_id uuid,email text,is_primary boolean,verified_at timestamptz);
 create table organizations(id uuid primary key,slug text,deleted_at timestamptz);
 create table memberships(organization_id uuid,user_id uuid,role text,updated_at timestamptz default now());
 create table permissions(organization_id uuid,user_id uuid,capability text,deny boolean,scope_type text,scope_id uuid,revoked_at timestamptz);
 create table audit_events(organization_id uuid,actor_user_id uuid,action text,target text);
 create table cid_public_profiles(slug text primary key,organization_id uuid,profile jsonb,version int default 1,updated_at timestamptz,updated_by uuid);`);
 migration=await readFile(new URL('../drizzle/0060_complete_cid_setup.sql',import.meta.url),'utf8');
},60000);
beforeEach(async()=>{
 await pg.exec('truncate users,user_emails,organizations,memberships,permissions,audit_events,cid_public_profiles;');
 await pg.query("insert into users(id,auth_user_id) values($1,'auth-paolo'),($2,'auth-other')",[uid,other]);
 await pg.query("insert into user_emails values($1,'paolo@tboxstudio.com',true,now())",[uid]);
 await pg.query("insert into organizations(id,slug) values($1,'tbox-studio'),($2,'workwear-toronto'),($3,'rotary-store')",[tbox,workwear,rotary]);
 await pg.query("insert into memberships(organization_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",[tbox,uid,workwear,other]);
 await pg.query("insert into cid_public_profiles(slug,organization_id,profile) values('workweartoronto',$1,'{}'),('rotary',$2,'{\"displayName\":\"Rotary\",\"showOwnership\":false}')",[workwear,rotary]);
});
afterAll(async()=>{await pg.close();});
test('assigns only Paolo as Workwear editor and fills verified Rotary fields once',async()=>{
 await pg.exec(migration);await pg.exec(migration);
 expect((await pg.query<{role:string}>('select role from memberships where organization_id=$1 and user_id=$2',[workwear,uid])).rows).toEqual([{role:'editor'}]);
 expect((await pg.query<{role:string}>('select role from memberships where organization_id=$1 and user_id=$2',[workwear,other])).rows).toEqual([{role:'owner'}]);
 const row=(await pg.query<{profile:Record<string,unknown>;version:number}>("select profile,version from cid_public_profiles where slug='rotary'")).rows[0];
 expect(row.profile.email).toBe('Rotary@BrandingCentres.com');expect(row.profile.phone).toBe('+1 416-288-8661');expect(row.profile.mapsUrl).toContain('google.com/maps/dir/');
 expect(row.profile).not.toHaveProperty('facebook');expect(row.profile.showOwnership).toBe(false);expect(row.version).toBe(2);
 expect((await pg.query<{count:number}>('select count(*)::int as count from audit_events')).rows[0].count).toBe(2);
 expect((await pg.query('select * from permissions')).rows).toEqual([]);
});
test('preserves existing public values and stronger memberships',async()=>{
 await pg.query("insert into memberships(organization_id,user_id,role) values($1,$2,'owner')",[workwear,uid]);
 await pg.query("update cid_public_profiles set profile=profile || '{\"email\":\"chosen@example.com\",\"facebook\":\"https://facebook.com/chosen\"}'::jsonb where slug='rotary'");
 await pg.exec(migration);
 expect((await pg.query<{role:string}>('select role from memberships where organization_id=$1 and user_id=$2',[workwear,uid])).rows[0].role).toBe('owner');
 const row=(await pg.query<{profile:Record<string,unknown>}>("select profile from cid_public_profiles where slug='rotary'")).rows[0];expect(row.profile.email).toBe('chosen@example.com');expect(row.profile.facebook).toBe('https://facebook.com/chosen');
});
test('absent or unlinked identity grants no access and publishes no data',async()=>{
 await pg.query('update users set auth_user_id=null where id=$1',[uid]);await pg.exec(migration);
 expect((await pg.query('select * from memberships where organization_id=$1 and user_id=$2',[workwear,uid])).rows).toEqual([]);
 expect((await pg.query<{version:number}>("select version from cid_public_profiles where slug='rotary'")).rows[0].version).toBe(1);
});
test('respects explicit denies and rolls back instead of inventing a company mapping',async()=>{
 await pg.query("insert into permissions values($1,$2,'cid.profile.write',true,'organization',null,null)",[workwear,uid]);
 await expect(pg.exec(migration)).rejects.toThrow('explicit profile editing denial');
 await pg.exec('delete from permissions');await pg.query("delete from cid_public_profiles where slug='rotary'");
 await expect(pg.exec(migration)).rejects.toThrow('existing Workwear and Rotary-store');
 expect((await pg.query('select * from audit_events')).rows).toEqual([]);
});
