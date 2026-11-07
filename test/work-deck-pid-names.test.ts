import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

test("Work Deck names follow verified PiDs and CiD roster visibility", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE portal_app;
      CREATE ROLE portal_auth;
      CREATE TABLE "CiD" (
        id uuid PRIMARY KEY, deleted_at timestamptz, member_visibility text NOT NULL DEFAULT 'closed'
      );
      CREATE TABLE users (
        id uuid PRIMARY KEY, auth_user_id text UNIQUE, deleted_at timestamptz,
        is_service boolean NOT NULL DEFAULT false
      );
      CREATE TABLE "role" (organization_id uuid, user_id uuid, role text);
      CREATE TABLE auth_users (id text PRIMARY KEY, name text, email_verified boolean);
      INSERT INTO "CiD" (id) VALUES
        ('00000000-0000-4000-8000-000000000001'),
        ('00000000-0000-4000-8000-000000000002');
      INSERT INTO auth_users VALUES
        ('member', '  de la Cruz  ', true),
        ('unverified', 'Unverified name', false),
        ('viewer', 'Viewer name', true),
        ('outside', 'Outside name', true),
        ('service', 'Website Forms', true);
      INSERT INTO users (id, auth_user_id) VALUES
        ('00000000-0000-4000-8000-000000000011', NULL),
        ('00000000-0000-4000-8000-000000000012', 'member'),
        ('00000000-0000-4000-8000-000000000013', 'unverified'),
        ('00000000-0000-4000-8000-000000000014', 'viewer'),
        ('00000000-0000-4000-8000-000000000015', 'outside'),
        ('00000000-0000-4000-8000-000000000016', 'service');
      UPDATE users SET is_service = true WHERE auth_user_id = 'service';
      INSERT INTO "role" VALUES
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 'owner'),
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000012', 'member'),
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000013', 'member'),
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000014', 'viewer'),
        ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000015', 'owner'),
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000016', 'member');
    `);
    const migration = await readFile(new URL("../drizzle/0062_work_deck_pid_names.sql", import.meta.url), "utf8");
    await db.exec(migration);

    const names = () => db.query("SELECT * FROM public.work_deck_pid_names() ORDER BY user_id");
    const scope = (companyId: string, actorId: string) => db.query(
      "SELECT set_config('app.org_id', $1, false), set_config('app.user_id', $2, false)",
      [companyId, actorId],
    );
    const company = "00000000-0000-4000-8000-000000000001";
    const owner = "00000000-0000-4000-8000-000000000011";
    const member = "00000000-0000-4000-8000-000000000012";
    const unverified = "00000000-0000-4000-8000-000000000013";
    const viewer = "00000000-0000-4000-8000-000000000014";
    const outside = "00000000-0000-4000-8000-000000000015";

    await db.exec("SET ROLE portal_app");
    expect((await names()).rows).toEqual([]);
    await scope(company, owner);
    const closedRoster = [
      { user_id: owner, display_name: null },
      { user_id: member, display_name: "de la Cruz" },
      { user_id: unverified, display_name: null },
    ];
    const viewerName = { user_id: viewer, display_name: "Viewer name" };
    expect((await names()).rows).toEqual([...closedRoster, viewerName]);
    await scope(company, member);
    expect((await names()).rows).toEqual(closedRoster);
    expect((await db.query("SELECT has_table_privilege('public.auth_users', 'SELECT') AS allowed")).rows)
      .toEqual([{ allowed: false }]);
    await scope(company, outside);
    expect((await names()).rows).toEqual([]);
    await scope(company, viewer);
    expect((await names()).rows).toEqual([]);

    await db.exec(`
      RESET ROLE;
      UPDATE "CiD" SET member_visibility = 'open' WHERE id = '${company}';
      UPDATE auth_users SET name = 'Renamed profile' WHERE id = 'member';
      SET ROLE portal_app;
    `);
    await scope(company, member);
    expect((await names()).rows).toEqual([
      closedRoster[0], { user_id: member, display_name: "Renamed profile" }, closedRoster[2], viewerName,
    ]);
    await db.exec("RESET ROLE; SET ROLE portal_auth");
    await expect(names()).rejects.toThrow(/permission denied/);
  } finally {
    await db.close();
  }
}, 60_000);
