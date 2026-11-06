import type { Client } from "pg";

/** Restore the original names inside a test transaction that will be rolled back. */
export async function restoreLegacyIdentityNames(db: Client) {
  await db.query(`
    drop view public.people, public.organizations, public.memberships;
    alter table public."PiD" rename to people;
    alter table public."CiD" rename to organizations;
    alter table public."role" rename to memberships;
  `);
}
