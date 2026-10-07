import pg from "pg";

/**
 * Confirm or reject the binding requests of accounts that existed before the
 * self-hosted sign-in (Better Auth, 0022) — and, for the same operators, the
 * two things a person cannot do for themselves once their phone is gone.
 *
 *   node scripts/identity-bindings.mjs list
 *   node scripts/identity-bindings.mjs confirm <request id> --operator "Full Name"
 *   node scripts/identity-bindings.mjs reject  <request id> --operator "Full Name"
 *   node scripts/identity-bindings.mjs reset-authenticator <email> --operator "Full Name"
 *   node scripts/identity-bindings.mjs sign-out-everywhere <email> --operator "Full Name"
 *
 * The first time such an account signs in with a verified address and passes
 * the authenticator, the login host records a request in identity_bindings and
 * lets the person no further. This is the answer. It connects as the OWNER
 * (DATABASE_URL), because the 0022 trigger lets nobody else set
 * users.auth_user_id on an existing account — the application can ask, and
 * only an operator can answer. (Requests from the never-deployed WorkOS
 * integration, workos_user_id, are handled the same way.)
 *
 * reset-authenticator removes the identity's authenticator and recovery codes
 * and ends its sessions; the person sets up a new one at their next sign-in.
 * Do it only after confirming who is asking, by a channel other than email.
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
    'Usage: identity-bindings.mjs list | confirm <id> --operator "Name" | reject <id> --operator "Name"\n' +
      '       | reset-authenticator <email> --operator "Name" | sign-out-everywhere <email> --operator "Name"',
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
  } else if (command === "reset-authenticator" || command === "sign-out-everywhere") {
    if (!id || !id.includes("@")) usage("An email address is required.");
    if (operator.length === 0) usage("Name the operator with --operator.");
    await recover(command, id.trim().toLowerCase(), operator);
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
    select b.id, b.email, b.workos_user_id, b.auth_user_id, b.requested_at,
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
        `  signed in as  ${r.email}  (${subjectLabel(r)})`,
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
      `select b.*, u.workos_user_id as bound_workos, u.auth_user_id as bound_auth, u.deleted_at
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
      const column = request.auth_user_id ? "auth_user_id" : "workos_user_id";
      const subject = request.auth_user_id ?? request.workos_user_id;
      const boundTo = request.auth_user_id ? request.bound_auth : request.bound_workos;
      if (boundTo) {
        throw new Error(`The account is already bound to ${boundTo}.`);
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

      const taken = await client.query(`select id from users where ${column} = $1`, [subject]);
      if (taken.rowCount > 0) {
        throw new Error("That sign-in is already bound to another account.");
      }

      await client.query(
        `update users set ${column} = $2, updated_at = now() where id = $1`,
        [request.user_id, subject],
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
      `${command === "confirm" ? "Confirmed" : "Rejected"}: ${request.email} (${subjectLabel(request)}), by ${decidedBy}.`,
    );
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

function subjectLabel(r) {
  return r.auth_user_id ? `sign-in ${r.auth_user_id}` : `WorkOS ${r.workos_user_id}`;
}

async function recover(command, email, by) {
  await client.query("begin");
  try {
    const { rows } = await client.query("select id from auth_users where email = $1 for update", [email]);
    const identity = rows[0];
    if (!identity) throw new Error(`No sign-in exists for ${email}.`);
    let factors = 0;
    if (command === "reset-authenticator") {
      factors = (await client.query("delete from auth_two_factors where user_id = $1", [identity.id])).rowCount;
    }
    const sessions = (await client.query("delete from auth_sessions where user_id = $1", [identity.id])).rowCount;
    // The portal sessions handed over from those sign-ins end with them.
    const portal = (
      await client.query(
        `update sessions set revoked_at = now()
          where revoked_at is null
            and user_id = (select id from users where auth_user_id = $1)`,
        [identity.id],
      )
    ).rowCount;
    await client.query("commit");
    console.log(
      `${command === "reset-authenticator" ? `Authenticator removed (${factors}); ` : ""}` +
        `${sessions} sign-in and ${portal} portal sessions ended for ${email}, by ${by}.`,
    );
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
