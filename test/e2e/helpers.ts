import type { Page } from "@playwright/test";
import { Client } from "pg";
import { createHmac } from "node:crypto";

/** Shared pieces for the browser suite (test/e2e/better-auth.spec.ts). */

/**
 * Open the account menu (the Pin), where Sign out and the signed-in address
 * live. A no-op when it is already open, so callers need not track it.
 */
export async function openAccountMenu(page: Page) {
  const pin = page.getByRole("button", { name: "Account and organization" });
  if ((await pin.getAttribute("aria-expanded")) !== "true") await pin.click();
  await page.getByRole("menu").waitFor();
}

/** Look up seeded ids, so tests attack real rows rather than invented ones. */
export async function seededIds() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows } = await db.query(`
    select
      (select id from jobs where ref = 'ROT-0001') as rotary_job,
      (select id from jobs where ref = 'NOR-0001') as northstar_job,
      (select title from jobs where ref = 'NOR-0001') as northstar_title
  `);
  await db.end();
  return rows[0] as {
    rotary_job: string;
    northstar_job: string;
    northstar_title: string;
  };
}

/**
 * Compute the current TOTP code from a base32 secret.
 *
 * Reimplemented here rather than imported from lib/auth/totp, which is marked
 * server-only and throws outside a server context. Keeping the test's own
 * implementation also means the code the app accepts is checked against an
 * independent calculation rather than against itself.
 */
export function totpCode(secretBase32: string, at = Date.now()): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of secretBase32.replace(/[^A-Z2-7]/gi, "").toUpperCase()) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}
