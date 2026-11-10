import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { expect, test } from 'vitest';

const branding = '20000000-0000-4000-8000-000000000001';
const rotary = '20000000-0000-4000-8000-000000000002';
const personal = '20000000-0000-4000-8000-000000000003';
const person = '20000000-0000-4000-8000-000000000004';
const company = '20000000-0000-4000-8000-000000000005';
const anotherAccount = '20000000-0000-4000-8000-000000000006';

test('address book migration preserves saved contact links and isolates book owners', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role portal_app;
      create table users(id uuid primary key);
      create table organizations(id uuid primary key, name text, deleted_at timestamptz);
      insert into users values ('${personal}'), ('${anotherAccount}');
      insert into organizations(id,name) values ('${branding}','Branding'), ('${rotary}','Rotary'), ('${company}','Company');
    `);
    for (const filename of ['0055_work_deck_contacts.sql', '0063_address_books.sql']) {
      if (filename.startsWith('0063')) {
        await db.exec(`
          insert into people(id) values ('${person}');
          insert into directory_people(organization_id,person_id,display_name,fingerprint)
            values ('${branding}','${person}','Sample','{"email":"person@example.test","social":"sample"}');
          insert into directory_companies(organization_id,company_id)
            values ('${branding}','${company}');
          insert into work_deck_contacts(organization_id,deck_ref,person_id,company_id)
            values ('${branding}','1042','${person}','${company}');
        `);
      }
      await db.exec(await readFile(new URL('../drizzle/' + filename, import.meta.url), 'utf8'));
    }
    await db.exec(`
      set role portal_app;
      select set_config('app.org_id','${branding}',false),set_config('app.user_id','${personal}',false);
      insert into public.address_book_entries(book_kind,book_id,kind,name,roles,source)
        values ('personal','${personal}','person','My contact',array['Billing','Approvals'],'manual');
    `);
    const linked = await db.query(`select person_id, company_id from public.address_book_deck_contacts`);
    expect(linked.rows).toEqual([{ person_id: person, company_id: company }]);
    const backfilled = await db.query(`select email, details from public.address_book_entries where id = '${person}'`);
    expect(backfilled.rows).toEqual([{
      email: 'person@example.test', details: { email: 'person@example.test', social: 'sample' },
    }]);
    await db.exec(`select set_config('app.org_id','${rotary}',false),set_config('app.user_id','${anotherAccount}',false)`);
    expect((await db.query('select name from public.address_book_entries')).rows).toEqual([]);
    expect((await db.query('select deck_ref from public.address_book_deck_contacts')).rows).toEqual([]);
    await expect(db.exec(`insert into public.address_book_entries(book_kind,book_id,kind,name,source)
      values ('company','${branding}','person','Cross-book write','manual')`)).rejects.toThrow(/row-level security/);
    await expect(db.exec(`insert into public.address_book_entries(book_kind,book_id,kind,name,company_id,source)
      values ('company','${rotary}','person','Cross-book relationship','${company}','manual')`)).rejects.toThrow(/foreign key/);
  } finally {
    await db.close();
  }
}, 60000);
