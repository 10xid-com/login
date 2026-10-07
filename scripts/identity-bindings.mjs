import pg from "pg";

/**
 * Confirm or reject the WorkOS binding requests of accounts that existed
 * before WorkOS.
 *
 *   node scripts/identity-bindings.mjs list
 *   node scripts/identity-bindings.mjs confirm <request id> --operator "Full Name"
 *   node scripts/identity-bindings.mjs reject  <request id> --operator "Full Name"
 *
 * The first time such an account signs in through WorkOS with a verified
 * address, the portal records a request in identity_bindings and lets the
 * person no further. This is the answer. It connects as the OWNER
 * (DATABASE_URL), because the 0021 trigger lets nobody else set
 * users.workos_user_id on an existing account — the application can ask, and
 * only an operator can answer.
 *
 * Before confirming, check with the person by a channel other than this
 * sign-in (a call to a number already on file, say) that they are the one who
 * just signed in. The request proves that somebody holds the inbox; the
 * confirmation is what says that somebody is the account's owner.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL (the owner connection) is not set.");
  process.exit(1);
}

const [command, id, ...rest] = process.argv.slice(2);
const operatorFlag = rest.indexOf("--operator");
const operator = operatorFlag >= 0 ? (rest[operatorFlag + 1] ?? "").trim() : "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(message) {
  if (message) console.error(message);
  console.error(
    'Usage: identity-bindings.mjs list | confirm <id> --operator "Name" | reject <id> --operator "Name"',
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  if (command === "list") {
    await list();
  } else if (command === "confirm" || command === "reject") {
    if (!UUID.test(id ?? "")) usage("A request id is required.");
    if (operator.length === 0) usage("Name the operator with --operator.");
    await decide(command, id, operator);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}

async function list() {
  const { rows } = await client.query(`
    select b.id, b.email, b.workos_user_id, b.requested_at,
           u.email as account_email, u.full_name,
           coalesce(
             (select string_agg(o.name || ' (' || m.role || ')', ', ' order by o.name)
                from memberships m join organizations o on o.id = m.organization_id
               where m.user_id = u.id and o.deleted_at is null),
             'no businesses'
           ) as businesses
      from identity_bindings b
      join users u on u.id = b.user_id
     where b.decision is null
     order by b.requested_at
  `);
  if (rows.length === 0) {
    console.log("No open binding requests.");
    return;
  }
  for (const r of rows) {
    console.log(
      [
        `${r.id}`,
        `  signed in as  ${r.email}  (WorkOS ${r.workos_user_id})`,
        `  account       ${r.account_email}${r.full_name ? ` — ${r.full_name}` : ""}`,
        `  businesses    ${r.businesses}`,
        `  requested     ${r.requested_at.toISOString()}`,
      ].join("\n"),
    );
  }
}

async function decide(command, requestId, decidedBy) {
  await client.query("begin");
  try {
    const { rows } = await client.query(
      `select b.*, u.workos_user_id as bound_to, u.deleted_at
         from identity_bindings b join users u on u.id = b.user_id
        where b.id = $1
        for update of b, u`,
      [requestId],
    );
    const request = rows[0];
    if (!request) throw new Error("No such request.");
    if (request.decision) {
      throw new Error(`Already ${request.decision} by ${request.decided_by}.`);
    }

    if (command === "confirm") {
      if (request.deleted_at) throw new Error("The account has been deleted.");
      if (request.bound_to) {
        throw new Error(`The account is already bound to ${request.bound_to}.`);
      }

      // The address must still belong to the account: the primary, or a
      // verified secondary — the same rule sign-in has always used.
      const owned = await client.query(
        `select 1 from user_emails
          where user_id = $1 and email = $2
            and (is_primary or verified_at is not null)`,
        [request.user_id, request.email],
      );
      if (owned.rowCount === 0) {
        throw new Error(`${request.email} no longer belongs to this account.`);
      }

      const taken = await client.query(
        "select id from users where workos_user_id = $1",
        [request.workos_user_id],
      );
      if (taken.rowCount > 0) {
        throw new Error("That WorkOS user is already bound to another account.");
      }

      await client.query(
        "update users set workos_user_id = $2, updated_at = now() where id = $1",
        [request.user_id, request.workos_user_id],
      );
    }

    await client.query(
      `update identity_bindings
          set decision = $2, decided_at = now(), decided_by = $3
        where id = $1`,
      [requestId, command === "confirm" ? "confirmed" : "rejected", decidedBy],
    );
    await client.query("commit");
    console.log(
      `${command === "confirm" ? "Confirmed" : "Rejected"}: ${request.email} (${request.workos_user_id}), by ${decidedBy}.`,
    );
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
