-- 0021 — WORKOS IS WHO SIGNED IN; THIS DATABASE IS WHAT THEY MAY DO.
--
-- The foundation of the 10XiD Build Brief (agreed 2026-10-07): sign-in moves to
-- WorkOS AuthKit, and a local account is found by the WorkOS user id rather
-- than by an address. Additive only. Nothing the deployed application reads is
-- changed or removed, so this can be applied before the application that uses
-- it is deployed.
--
--   1. users.workos_user_id — the identity key. Unique, nullable until bound.
--   2. A trigger making it bind-once, and operator-only on an existing account.
--   3. identity_bindings — the request an existing account makes on its first
--      WorkOS sign-in, which an operator confirms or rejects.
--   4. The six role templates on membership_role.
--
-- Decisions behind it (Paolo, 2026-10-07): an existing account is bound on its
-- first WorkOS sign-in with a verified address, and an operator confirms it;
-- `owner` maps to the owner template and every other action is denied until
-- the permission matrix is written; staff access is turned off.
--
-- Replayable like 0012–0017: IF NOT EXISTS throughout, CREATE OR REPLACE for
-- the function, DROP TRIGGER IF EXISTS before CREATE TRIGGER.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "workos_user_id" text;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_workos_user_id_unique'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_workos_user_id_unique" UNIQUE ("workos_user_id");
  END IF;
END
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Bind once, and only the owner binds an existing account.
--
-- portal_app holds table-wide UPDATE on users, and the is_staff trigger (0017)
-- runs as portal_app and needs it, so narrowing the grant to columns would
-- break that and every column added later. A trigger states the rule instead:
--
--   * a WorkOS id, once set, never changes — not to another id, not to null.
--     Re-pointing an account at a different WorkOS user is handing it to a
--     different person, and that is not something an UPDATE should be able to
--     do quietly. Recovery, if it is ever needed, is a deliberate act by the
--     database owner disabling this trigger, and is visible as such.
--   * setting it on an existing row is refused unless the caller is a member
--     of the role that owns the table: the operator's connection, never the
--     application's. The application can ask (identity_bindings) but cannot
--     answer.
--
-- INSERT is not covered, on purpose. A new account created by accepting an
-- invitation is bound at birth: WorkOS verified the address, and the
-- invitation was made out to exactly that address.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION users_workos_user_id_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  table_owner oid;
BEGIN
  IF NEW.workos_user_id IS NOT DISTINCT FROM OLD.workos_user_id THEN
    RETURN NEW;
  END IF;

  IF OLD.workos_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'users.workos_user_id is set once and never changed (account %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT relowner INTO table_owner FROM pg_class WHERE oid = TG_RELID;
  IF NOT pg_has_role(current_user, table_owner, 'USAGE') THEN
    RAISE EXCEPTION 'Only an operator binds an existing account to a WorkOS user (account %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS users_workos_user_id_guard ON "users";--> statement-breakpoint

CREATE TRIGGER users_workos_user_id_guard
  BEFORE UPDATE OF "workos_user_id" ON "users"
  FOR EACH ROW
  EXECUTE FUNCTION users_workos_user_id_guard();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Binding requests.
--
-- At most one open request per account and one per WorkOS user, so a person
-- signing in again does not pile up rows and an operator never sees two
-- competing requests for one account. A decided request is kept, with who
-- decided and when, and a new one can follow it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "identity_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "workos_user_id" text NOT NULL,
  "email" text NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decision" text,
  "decided_at" timestamp with time zone,
  "decided_by" text,
  CONSTRAINT "identity_bindings_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id"),
  CONSTRAINT "identity_bindings_decision_valid"
    CHECK ("decision" IS NULL OR "decision" IN ('confirmed', 'rejected')),
  CONSTRAINT "identity_bindings_decided_together"
    CHECK (
      ("decision" IS NULL AND "decided_at" IS NULL AND "decided_by" IS NULL)
      OR ("decision" IS NOT NULL AND "decided_at" IS NOT NULL
          AND length(trim("decided_by")) > 0)
    ),
  CONSTRAINT "identity_bindings_email_lowercase"
    CHECK ("email" = lower(trim("email")))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "identity_bindings_user_idx"
  ON "identity_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_bindings_workos_user_idx"
  ON "identity_bindings" USING btree ("workos_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_bindings_one_open_per_user"
  ON "identity_bindings" ("user_id") WHERE "decision" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_bindings_one_open_per_workos_user"
  ON "identity_bindings" ("workos_user_id") WHERE "decision" IS NULL;--> statement-breakpoint

-- Ask, never answer: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON "identity_bindings" TO portal_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. The role templates.
--
-- `member` and `staff` stay: existing rows carry them and Postgres cannot drop
-- an enum value. Neither is granted any action by the application.
-- ---------------------------------------------------------------------------
ALTER TYPE "public"."membership_role" ADD VALUE IF NOT EXISTS 'manager';--> statement-breakpoint
ALTER TYPE "public"."membership_role" ADD VALUE IF NOT EXISTS 'editor';--> statement-breakpoint
ALTER TYPE "public"."membership_role" ADD VALUE IF NOT EXISTS 'publisher';--> statement-breakpoint
ALTER TYPE "public"."membership_role" ADD VALUE IF NOT EXISTS 'asset_manager';--> statement-breakpoint
ALTER TYPE "public"."membership_role" ADD VALUE IF NOT EXISTS 'viewer';
