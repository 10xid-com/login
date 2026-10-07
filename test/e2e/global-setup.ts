import { Client } from "pg";
import { rm } from "node:fs/promises";

/**
 * Reset sign-in state before a run.
 *
 * Without this, a second run of the suite fails — and fails for a reason worth
 * keeping: requesting a sign-in code is rate limited to a few attempts per
 * address per quarter of an hour, so a suite that signs the same person in
 * repeatedly exhausts the allowance and is redirected to the rate-limit page
 * instead of the code page.
 *
 * The right response is to reset the state between runs rather than to raise
 * the limit for tests, because a limit that is relaxed for testing is a limit
 * nobody is testing.
 */
export default async function globalSetup() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query("truncate sign_in_codes, sso_tickets, sessions cascade");
  // Rate-limit counters, so one run does not inherit the last one's.
  await db.query("delete from auth_rate_limits");
  await db.end();

  await rm(process.env.DEV_CODE_SINK ?? "/tmp/portal-signin-codes.log", {
    force: true,
  });
}
