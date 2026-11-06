import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

/**
 * THE ONLY MODULE THAT OPENS A DATABASE CONNECTION.
 *
 * Nothing outside `lib/db/` may import this file — an ESLint rule fails the
 * build if anything tries. Everything else goes through the scoped helpers in
 * `lib/db/index.ts`, which cannot be called without a scope.
 *
 * The application connects as a RESTRICTED role. If it were to connect as the
 * table owner or a superuser, Postgres would silently ignore every row-level
 * security policy and the tenant isolation would evaporate without a single
 * error — so `assertRestrictedRole()` refuses to let the app boot in that case.
 */

if (!process.env.DATABASE_APP_URL) {
  throw new Error(
    "DATABASE_APP_URL is not set. The application must connect as the " +
      "restricted role, not as the migration owner in DATABASE_URL.",
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_APP_URL,
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  // Every scoped query runs inside a transaction, so a connection is held for
  // the duration of one request's work and released immediately after.
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

let assertionRun = false;

/**
 * Fails loudly at boot rather than quietly at runtime.
 *
 * This is the check that catches the single most common way tenant isolation is
 * lost: connecting as a role that bypasses the rules, writing an isolation test,
 * watching it pass, and shipping with no protection at all.
 */
export async function assertRestrictedRole(): Promise<void> {
  if (assertionRun) return;

  const { rows } = await pool.query<{
    role: string;
    is_super: boolean;
    can_bypass: boolean;
    owns_tenant_tables: number;
  }>(`
    select
      current_user as role,
      r.rolsuper as is_super,
      r.rolbypassrls as can_bypass,
      (select count(*)::int
         from pg_tables
        where schemaname in ('public', 'work', 'system')
          and tablename in ('jobs','job_events','api_keys','invitations')
          and tableowner = current_user) as owns_tenant_tables
    from pg_roles r
    where r.rolname = current_user
  `);

  const row = rows[0];
  if (!row) throw new Error("Could not determine the database role.");

  const faults: string[] = [];
  if (row.is_super) faults.push("it is a SUPERUSER");
  if (row.can_bypass) faults.push("it has BYPASSRLS");
  if (row.owns_tenant_tables > 0) faults.push("it OWNS the tenant tables");

  if (faults.length > 0) {
    throw new Error(
      `Refusing to start: the application is connecting as "${row.role}", and ` +
        `${faults.join(", ")}. Postgres ignores row-level security in that case, ` +
        `so every client would be able to read every other client's data with no ` +
        `error raised. Point DATABASE_APP_URL at the restricted role.`,
    );
  }

  assertionRun = true;
}

/**
 * Applies the per-request tenant setting and runs the callback inside one
 * transaction.
 *
 * The third argument to set_config is `true`, meaning TRANSACTION-LOCAL. That
 * is not a stylistic choice: with a connection pool, a session-level setting
 * stays on the connection after the request ends and is inherited by whoever
 * borrows that connection next — which may be a different client. That failure
 * mode leaks data rather than blocking it, so it is closed here, in the one
 * place every query passes through.
 */
export async function inTenantTransaction<T>(
  organizationId: string | null,
  isStaff: boolean,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.org_id', ${organizationId ?? ""}, true),
        set_config('app.is_staff', ${isStaff ? "on" : "off"}, true)
    `);
    return fn(tx);
  });
}

/**
 * The one transaction that is allowed to read a row before a scope exists.
 *
 * An API key has to be looked up before anyone knows which company it belongs
 * to — the key is what PRODUCES the scope, so it cannot require one, the same
 * circular problem sessions and memberships have. Those tables resolve it by
 * sitting outside row-level security entirely, with the reason written down in
 * scripts/check-rls.ts.
 *
 * Keys do not, because the same table is also managed through the ordinary
 * screens, and that management must be isolated per client like everything
 * else. So the table keeps its tenant policy, and this adds one narrow,
 * named exception: a SELECT-only policy that only applies while this flag is
 * set. The flag is transaction-local, is set here and nowhere else, and the
 * only query that runs inside it is a lookup by the hash of the presented key.
 *
 * It admits every key row, which sounds worse than it is: the rows hold hashes,
 * so what it can see is not a credential. Nothing may write inside it.
 */
/**
 * A transaction scoped to one client AND one person.
 *
 * The workspace tables (0018) filter by both: a conversation belongs to the
 * staff member who had it, not to everyone working on that client. This sets
 * app.user_id beside app.org_id. The cross-client staff flag is always off —
 * no workspace table has a survey policy, and passing it here would be a
 * promise the policies do not keep.
 *
 * A separate function rather than a fourth argument to inTenantTransaction, so
 * the dozens of existing callers are untouched and none of them can pass a
 * user id by accident.
 */
export async function inOwnerTransaction<T>(
  organizationId: string,
  userId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.org_id', ${organizationId}, true),
        set_config('app.is_staff', 'off', true),
        set_config('app.user_id', ${userId}, true)
    `);
    return fn(tx);
  });
}

export async function inAuthenticationTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.authenticating', 'on', true)`,
    );
    return fn(tx);
  });
}

/** For tests and scripts that need to close cleanly. */
export async function closePool(): Promise<void> {
  await pool.end();
}
