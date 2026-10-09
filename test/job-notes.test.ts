import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

/**
 * 0031: notes on a job, and handing a job to a teammate.
 *
 * Asked of Postgres directly, as the restricted role the application uses,
 * so what is proved is the database's rule and not the TypeScript above it.
 * Every write happens inside a transaction that is rolled back, so the
 * seeded fixtures the other files rely on are left as they were.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const appRole = new Client({ connectionString: process.env.DATABASE_APP_URL });

let rotaryId = "";
let northstarId = "";
let janeId = "";
let samId = "";
let rotaryJobId = "";
let northstarJobId = "";

beforeAll(async () => {
  await owner.connect();
  await appRole.connect();
  const { rows } = await owner.query(`
    select
      (select id from organizations where slug = 'rotary')    as rotary,
      (select id from organizations where slug = 'northstar') as northstar,
      (select id from users where email = 'jane@rotary.test')  as jane,
      (select id from users where email = 'sam@northstar.test') as sam,
      (select id from jobs where ref = 'ROT-0001')            as rotary_job,
      (select id from jobs where ref = 'NOR-0001')            as northstar_job
  `);
  ({ rotary: rotaryId, northstar: northstarId, jane: janeId, sam: samId } = rows[0]);
  rotaryJobId = rows[0].rotary_job;
  northstarJobId = rows[0].northstar_job;
  expect(rotaryJobId, "seed data missing — run npm run db:seed").toBeTruthy();
});

afterAll(async () => {
  await owner.end();
  await appRole.end();
});

/** Run as the application, scoped to one business, and always roll back. */
async function asBusiness<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  await appRole.query("begin");
  try {
    await appRole.query("select set_config('app.org_id', $1, true)", [orgId]);
    return await fn();
  } finally {
    await appRole.query("rollback");
  }
}

const insertNote = (jobId: string, orgId: string | null, body: string, handedTo: string | null = null) =>
  appRole.query(
    `insert into job_notes (id, job_id, organization_id, author_id, author_email_at_time, body, handed_to)
     values ($1, $2, $3, $4, 'jane@rotary.test', $5, $6) returning organization_id, created_at`,
    [randomUUID(), jobId, orgId, janeId, body, handedTo],
  );

describe("notes on a job", () => {
  test("a business writes a note on its own job, and its business is the job's", async () => {
    await asBusiness(rotaryId, async () => {
      const { rows } = await insertNote(rotaryJobId, null, "Client wants navy thread.");
      expect(rows[0].organization_id).toBe(rotaryId);
      const seen = await appRole.query("select body from job_notes where job_id = $1", [rotaryJobId]);
      expect(seen.rows.map((r) => r.body)).toContain("Client wants navy thread.");
    });
  });

  test("another business's job cannot be written on, even naming one's own business", async () => {
    await asBusiness(rotaryId, async () => {
      await expect(insertNote(northstarJobId, rotaryId, "smuggled")).rejects.toThrow(/does not exist/);
    });
  });

  test("another business's notes are invisible", async () => {
    // Committed by the owner, so its absence below is the policy's doing and
    // not an uncommitted row; removed again afterwards.
    await owner.query(
      `insert into job_notes (id, job_id, organization_id, author_id, author_email_at_time, body)
       values ($1, $2, $3, $4, 'sam@northstar.test', 'Northstar only')`,
      [randomUUID(), northstarJobId, northstarId, samId],
    );
    try {
      const seen = await asBusiness(rotaryId, () =>
        appRole.query("select count(*)::int as n from job_notes where job_id = $1", [northstarJobId]),
      );
      expect(seen.rows[0].n).toBe(0);
      const unscoped = await appRole.query("select count(*)::int as n from job_notes");
      expect(unscoped.rows[0].n).toBe(0);
    } finally {
      await owner.query("delete from job_notes where body = 'Northstar only'");
    }
  });

  test("a note cannot be edited or deleted", async () => {
    await expect(appRole.query("update job_notes set body = 'rewritten'")).rejects.toThrow(/permission denied/i);
    await expect(appRole.query("delete from job_notes")).rejects.toThrow(/permission denied/i);
  });

  test("an empty note is refused", async () => {
    await asBusiness(rotaryId, async () => {
      await expect(insertNote(rotaryJobId, null, "   ")).rejects.toThrow(/job_notes_body_sane/);
    });
  });
});

describe("handing a job over", () => {
  test("to a person of the business, it is allowed", async () => {
    await asBusiness(rotaryId, async () => {
      const { rows } = await appRole.query(
        "update jobs set assigned_to = $1 where id = $2 returning assigned_to",
        [janeId, rotaryJobId],
      );
      expect(rows[0].assigned_to).toBe(janeId);
      await expect(insertNote(rotaryJobId, null, "Yours now.", janeId)).resolves.toBeTruthy();
    });
  });

  test("to somebody of another business, it is refused", async () => {
    await asBusiness(rotaryId, async () => {
      await expect(
        appRole.query("update jobs set assigned_to = $1 where id = $2", [samId, rotaryJobId]),
      ).rejects.toThrow(/person of its business/);
    });
    await asBusiness(rotaryId, async () => {
      await expect(insertNote(rotaryJobId, null, "Yours now.", samId)).rejects.toThrow(/person of its business/);
    });
  });

  test("an assignment made before 0031 is left alone when something else changes", async () => {
    await owner.query("begin");
    try {
      await owner.query("alter table jobs disable trigger jobs_assignee_rules");
      await owner.query("update jobs set assigned_to = $1 where id = $2", [samId, rotaryJobId]);
      await owner.query("alter table jobs enable trigger jobs_assignee_rules");
      const { rows } = await owner.query(
        "update jobs set title = title where id = $1 returning assigned_to",
        [rotaryJobId],
      );
      expect(rows[0].assigned_to).toBe(samId);
    } finally {
      await owner.query("rollback");
    }
  });
});
