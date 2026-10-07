import "server-only";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { authDb } from "@/lib/db/auth-connection";

/**
 * Rate limits for the sign-in pages' server actions.
 *
 * Better Auth's own limits run only in its HTTP router (/api/auth/*). The
 * pages call it in-process, which skips them, so every action that checks a
 * secret or sends a mail counts here first — by client address and, where
 * there is one, by the address or identity being tried. Counters live in the
 * database (auth_rate_limits, under their own key prefix) so every instance
 * shares them, and the increment is one atomic upsert.
 */

type Rule = { window: number; max: number };

export const LIMITS = {
  password: { ip: { window: 300, max: 20 }, subject: { window: 900, max: 10 } },
  requestCode: { ip: { window: 600, max: 20 }, subject: { window: 600, max: 5 } },
  useCode: { ip: { window: 600, max: 30 }, subject: { window: 600, max: 10 } },
  mfa: { ip: { window: 300, max: 30 }, subject: { window: 300, max: 10 } },
  requestReset: { ip: { window: 600, max: 10 }, subject: { window: 600, max: 3 } },
  reset: { ip: { window: 600, max: 20 }, subject: { window: 600, max: 10 } },
  setPassword: { ip: { window: 600, max: 20 }, subject: { window: 600, max: 5 } },
  provider: { ip: { window: 600, max: 30 }, subject: { window: 600, max: 30 } },
} satisfies Record<string, { ip: Rule; subject: Rule }>;

async function hit(key: string, rule: Rule): Promise<boolean> {
  const now = Date.now();
  const since = now - rule.window * 1000;
  const result = await authDb().execute<{ count: number }>(sql`
    insert into auth_rate_limits (id, key, count, last_request)
    values (${randomUUID()}, ${key}, 1, ${now})
    on conflict (key) do update set
      count = case when auth_rate_limits.last_request < ${since} then 1 else auth_rate_limits.count + 1 end,
      last_request = case when auth_rate_limits.last_request < ${since} then ${now} else auth_rate_limits.last_request end
    returning count
  `);
  return Number(result.rows[0]?.count ?? 0) <= rule.max;
}

export async function clientAddress(): Promise<string> {
  const header = (process.env.CLIENT_IP_HEADER || "x-real-ip").toLowerCase();
  return ((await headers()).get(header) ?? "unknown").trim().slice(0, 64);
}

/** True when this attempt is within both limits; counts it either way. */
export async function allow(action: keyof typeof LIMITS, subject?: string): Promise<boolean> {
  const rules = LIMITS[action];
  const byAddress = await hit(`action:${action}:ip:${await clientAddress()}`, rules.ip);
  const bySubject = subject ? await hit(`action:${action}:sub:${subject.toLowerCase()}`, rules.subject) : true;
  return byAddress && bySubject;
}
