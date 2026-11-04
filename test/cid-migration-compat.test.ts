import {test,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('existing production-only migrations skip absent accounts/collections without granting access',async()=>{
 const pg=new PGlite();await pg.waitReady;
 try{
  await pg.exec(`create role portal_app;create role portal_auth;
   create table organizations(id uuid primary key default gen_random_uuid(),name text,slug text,deleted_at timestamptz);
   create table users(id uuid primary key default gen_random_uuid(),full_name text,auth_user_id text,is_service boolean default false,deleted_at timestamptz);
   create table user_emails(user_id uuid,email text,is_primary boolean,verified_at timestamptz);
   create table memberships(organization_id uuid,user_id uuid,role text);
   insert into organizations(name,slug) values('TBox Studio','tbox-studio');
   insert into users(full_name) values('Paolo');
   insert into user_emails select id,'paolo@tboxstudio.com',true,now() from users;
   insert into memberships select o.id,u.id,'owner' from organizations o cross join users u;`);
  const before=await pg.query('select * from memberships');
  await pg.exec(await readFile(new URL('../drizzle/0057_rana_clothing_access.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../drizzle/0058_uid_inventory_owners.sql',import.meta.url),'utf8'));
  expect((await pg.query('select * from memberships')).rows).toEqual(before.rows);
  expect((await pg.query('select * from uid_inventory_owners')).rows).toEqual([]);
 }finally{await pg.close();}
},60000);
