import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/**
 * THE SIGN-IN ENGINE'S CONNECTION — portal_auth, not portal_app.
 *
 * Better Auth's tables (auth_*) hold password hashes, encrypted authenticator
 * secrets and recovery codes, and one-time codes. They are readable by one
 * restricted role, portal_auth (0022), and this pool is the only thing that
 * connects as it. The portal (app.10xid.com) connects as portal_app, which
 * holds no privilege on any of them, so a compromise of the portal reads none
 * of it.
 *
 * Opened lazily: `next build` imports route modules without the runtime
 * environment, and a missing URL must fail the request that needs it, loudly,
 * rather than the build.
 */

let pool: Pool | null = null;
let database: ReturnType<typeof drizzle<typeof schema>> | null = null;

function authPool(): Pool {
  if (pool) return pool;
  const url = process.env.AUTH_DATABASE_URL;
  if (!url) {
    throw new Error(
      "AUTH_DATABASE_URL is not set. The login host's sign-in engine connects " +
        "as the restricted portal_auth role, never as portal_app or the owner.",
    );
  }
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.AUTH_DATABASE_POOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

export function authDb() {
  database ??= drizzle(authPool(), { schema });
  return database;
}

/**
 * Refuse to start if the sign-in connection is anything but portal_auth as
 * 0022 made it: not a superuser, no BYPASSRLS (the session clocks are a
 * row-level policy), owning none of the tables, and unable to read the
 * portal's own tables.
 */
export async function assertAuthRole(): Promise<void> {
  const { rows } = await authPool().query<{
    role: string;
    is_super: boolean;
    can_bypass: boolean;
    owns_auth_tables: number;
    reads_users: boolean;
  }>(`
    select current_user as role,
           r.rolsuper as is_super,
           r.rolbypassrls as can_bypass,
           (select count(*)::int from pg_tables
             where schemaname = 'public' and tablename like 'auth\\_%'
               and tableowner = current_user) as owns_auth_tables,
           has_table_privilege(current_user, 'public.users', 'SELECT') as reads_users
      from pg_roles r where r.rolname = current_user
  `);
  const row = rows[0];
  if (!row) throw new Error("Could not determine the sign-in database role.");
  const faults: string[] = [];
  if (row.is_super) faults.push("it is a SUPERUSER");
  if (row.can_bypass) faults.push("it has BYPASSRLS, which switches off the session clocks");
  if (row.owns_auth_tables > 0) faults.push("it OWNS the sign-in tables");
  if (row.reads_users) faults.push("it can read the portal's users table");
  if (faults.length > 0) {
    throw new Error(
      `Refusing to start: the sign-in engine connects as "${row.role}", and ` +
        `${faults.join(", ")}. Point AUTH_DATABASE_URL at portal_auth.`,
    );
  }
}

/** For tests and scripts that need to close cleanly. */
export async function closeAuthPool(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
  database = null;
}
