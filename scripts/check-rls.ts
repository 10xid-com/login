import { Client } from "pg";

/**
 * Build-failing check: no table may quietly hold one client's data without the
 * database enforcing who can read it.
 *
 * The obvious version of this rule — "every table with an organization_id must
 * have row-level security" — is wrong, and wrong in a way that would get itself
 * switched off. Some tables legitimately need reading BEFORE any scope exists:
 * you cannot look up which company a hostname belongs to while already scoped
 * to a company, and you cannot resolve someone's memberships without reading
 * them first.
 *
 * So the rule is: every table carrying an organization id is either protected,
 * or listed below with a written reason. Adding a table forces that decision
 * rather than allowing it to be skipped silently — which is the actual failure
 * mode, since nobody forgets on purpose.
 */

/** Protected by row-level security. Must have RLS on AND at least one policy. */
const MUST_BE_PROTECTED = [
  "jobs",
  "job_events",
  "api_keys",
  "invitations",
  "departments",
  "department_members",
  "permissions",
  // Flow. Every touch, offer, attempt, verdict and audit line is one client's.
  "task_types",
  "tasks",
  "task_offers",
  "task_claims",
  "task_grades",
  "task_events",
  // The workspace. Conversations, runs and receipts are filtered by client
  // AND owner; workspaces and engine policies by client.
  "workspaces",
  "conversations",
  "conversation_messages",
  "agent_runs",
  "agent_run_receipts",
  "conversation_context_items",
  "engine_mode_policies",
  // Which client a repository belongs to. The link IS the authorisation.
  "repositories",
  // Grant decisions and what agency people do: one business's record.
  "audit_events",
];

/** Read before a scope exists. Each entry needs a reason that survives review. */
const EXEMPT: Record<string, string> = {
  organization_domains:
    "Looked up by hostname on an anonymous request, to theme the sign-in page " +
    "before anyone has a session. Contains no client data — only which brand " +
    "belongs to which address.",
  memberships:
    "Read to work out which companies a person belongs to. This is what " +
    "PRODUCES the scope, so it cannot itself require one.",
  staff_grants:
    "Read to establish which client a staff session currently holds. Same " +
    "reason as memberships: it is an input to the scope, not scoped data.",
  sessions:
    "Holds active_organization_id as part of the scope itself. Sessions are " +
    "found by token hash, never enumerated.",
  agency_grants:
    "Read to work out which client businesses an agency person may open. " +
    "Like memberships, it PRODUCES the scope, so it cannot require one. Its " +
    "rules (who may ask, approve, widen or end) are 0025's triggers.",
  agency_grant_reminders:
    "Delivery bookkeeping for agency-grant expiry reminders: which grant, " +
    "which recipient, whether it went. Read and written only by the " +
    "scheduled reminder run, which works across every business by design; " +
    "it holds ids and a delivery error, no business content. Its rules " +
    "(claimed once, sent is final, only failures retried) are 0026's trigger.",
  connections:
    "Holds rows with a NULL organization_id — two people who scanned each " +
    "other's iD know each other personally, and that belongs to no company. " +
    "A tenant policy compares organization_id to the current scope, and NULL " +
    "never matches, so protecting this table would silently erase every " +
    "personal connection from every query rather than isolating anything. " +
    "It is also an INPUT to visibility, in the same way memberships is an " +
    "input to scope: it is read to work out who a person may see, which " +
    "cannot itself require knowing who they may see.",
};

async function main() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment directly */
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  const { rows: carriers } = await client.query<{ tablename: string }>(`
    select distinct c.table_name as tablename
      from information_schema.columns c
      join pg_tables t
        on t.tablename = c.table_name and t.schemaname = c.table_schema
     where c.table_schema = 'public'
       and c.column_name like '%organization_id'
     order by 1
  `);

  const { rows: protection } = await client.query<{
    tablename: string;
    rls: boolean;
    policies: number;
  }>(`
    select t.tablename,
           t.rowsecurity as rls,
           (select count(*)::int from pg_policies p
             where p.schemaname = 'public' and p.tablename = t.tablename) as policies
      from pg_tables t
     where t.schemaname = 'public'
  `);

  await client.end();

  const state = new Map(protection.map((r) => [r.tablename, r]));
  const failures: string[] = [];

  for (const { tablename } of carriers) {
    const known =
      MUST_BE_PROTECTED.includes(tablename) || tablename in EXEMPT;
    if (!known) {
      failures.push(
        `${tablename} carries an organization id but is neither protected by ` +
          `row-level security nor listed as exempt. Add a policy, or add it to ` +
          `EXEMPT in scripts/check-rls.ts with the reason it is safe.`,
      );
    }
  }

  for (const tablename of MUST_BE_PROTECTED) {
    const row = state.get(tablename);
    if (!row) {
      failures.push(`${tablename} is expected to exist but was not found.`);
      continue;
    }
    if (!row.rls) {
      failures.push(
        `${tablename} does NOT have row-level security enabled. Every client ` +
          `could read every other client's rows.`,
      );
    }
    if (row.policies === 0) {
      failures.push(
        `${tablename} has row-level security enabled but no policies, so it ` +
          `returns nothing to the application at all.`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("\nTenant protection check FAILED:\n");
    for (const f of failures) console.error(`  ✗ ${f}\n`);
    process.exit(1);
  }

  console.log("Tenant protection check passed.");
  for (const t of MUST_BE_PROTECTED) {
    const row = state.get(t)!;
    console.log(`  ✓ ${t} — row-level security on, ${row.policies} policies`);
  }
  for (const [t, why] of Object.entries(EXEMPT)) {
    if (carriers.some((c) => c.tablename === t)) {
      console.log(`  • ${t} — exempt: ${why.split(".")[0]}.`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
