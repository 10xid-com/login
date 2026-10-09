import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";

/**
 * 0033: a job is a quote, an estimate, or a job. Asked of Postgres directly,
 * as the restricted role the application uses, inside a transaction that is
 * rolled back.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const appRole = new Client({ connectionString: process.env.DATABASE_APP_URL });

let rotaryId = "";
let rotaryJobId = "";

beforeAll(async () => {
  await owner.connect();
  await appRole.connect();
  const { rows } = await owner.query(`
    select (select id from organizations where slug = 'rotary') as rotary,
           (select id from jobs where ref = 'ROT-0001')        as rotary_job
  `);
  ({ rotary: rotaryId, rotary_job: rotaryJobId } = rows[0]);
  expect(rotaryJobId, "seed data missing — run npm run db:seed").toBeTruthy();
});

afterAll(async () => {
  await owner.end();
  await appRole.end();
});

async function asRotary<T>(fn: () => Promise<T>): Promise<T> {
  await appRole.query("begin");
  try {
    await appRole.query("select set_config('app.org_id', $1, true)", [rotaryId]);
    return await fn();
  } finally {
    await appRole.query("rollback");
  }
}

describe("a job's kind", () => {
  test("a job written without one is a job", async () => {
    const { rows } = await owner.query("select kind from jobs where id = $1", [rotaryJobId]);
    expect(rows[0].kind).toBe("job");
  });

  test("the business can make it a quote or an estimate", async () => {
    await asRotary(async () => {
      for (const kind of ["quote", "estimate", "job"]) {
        const { rows } = await appRole.query("update jobs set kind = $1 where id = $2 returning kind", [kind, rotaryJobId]);
        expect(rows[0].kind).toBe(kind);
      }
    });
  });

  test("nothing else is a kind", async () => {
    await asRotary(async () => {
      await expect(appRole.query("update jobs set kind = 'order' where id = $1", [rotaryJobId])).rejects.toThrow(
        /invalid input value for enum job_kind/,
      );
    });
  });
});
