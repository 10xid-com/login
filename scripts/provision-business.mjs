import pg from "pg";
import { pathToFileURL } from "node:url";

/**
 * Provision a private business owned by one existing person — idempotently,
 * and only after checking that nobody else can reach it.
 *
 *   DATABASE_URL=<owner connection> PROVISION_OWNER_EMAIL=<address> \
 *     node scripts/provision-business.mjs --name "Business name" --slug business-slug [--apply]
 *
 * Without --apply it does everything inside a transaction and rolls it back,
 * so a dry run shows exactly what --apply would do. Operator-only: it connects
 * as the OWNER (DATABASE_URL), like identity-bindings.mjs. It is not the
 * first-run bootstrap in migrate.mjs, which only ever runs on an empty database.
 *
 * WHO OWNS IT. The owner is an existing person, found through user_emails: the
 * address must be VERIFIED there and belong to an account that is neither
 * deleted nor a service account. Nobody is created, invited or bound: if no
 * such person exists, nothing happens. The address is read from
 * PROVISION_OWNER_EMAIL (or --owner-email) and is never printed.
 *
 * WHAT IT DOES, each step only if not already so:
 *   1. a business: an organization of type `client`, with this slug and name;
 *   2. the owner's membership of it, as `owner` — the membership is what gives
 *      access; organizations.owner_user_id only records who is answerable, and
 *      is set if empty;
 * and it never changes anything it did not create: an existing business with
 * this slug is used only if it is a live, non-agency client business whose
 * recorded owner (if any) is this person, and an existing membership is never
 * re-roled.
 *
 * WHAT IT VERIFIES before committing, refusing (and rolling back) otherwise:
 *   * exactly one membership, the owner's, as owner;
 *   * no open invitation;
 *   * no agency grant that is requested or active;
 *   * no live API key (a key acts as a service account of the business);
 *   * no hostname of its own.
 * Staff of the house can still open any client business through a staff grant
 * (typed reason, 30 minutes); inventory tables have no staff policy, so that
 * reaches none of its inventory.
 *
 * It prints the business id — the value for the app's INVENTORY_BUSINESSES —
 * and what it did.
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ProvisionRefused extends Error {}

/**
 * Make (or find) the business and the owner's membership, then verify it is
 * private. Runs on the caller's connection and transaction; it neither begins
 * nor ends one.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ name: string, slug: string, ownerEmail: string }} input
 * @returns {Promise<{ organizationId: string, createdBusiness: boolean, createdMembership: boolean, recordedOwner: boolean }>}
 */
export async function provisionBusiness(db, input) {
  const name = (input.name ?? "").trim();
  const slug = (input.slug ?? "").trim();
  const ownerEmail = (input.ownerEmail ?? "").trim().toLowerCase();
  if (name.length === 0 || name.length > 200) throw new ProvisionRefused("A business name is required (at most 200 characters).");
  if (!SLUG.test(slug) || slug.length > 100) {
    throw new ProvisionRefused("The slug is lowercase letters, digits and single hyphens (at most 100 characters).");
  }
  if (!ownerEmail.includes("@")) throw new ProvisionRefused("The owner's address is required.");

  // 1. The owner: a verified address of an active person.
  const people = (
    await db.query(
      `select u.id, u.is_service, u.deleted_at
         from user_emails e
         join users u on u.id = e.user_id
        where e.email = $1 and e.verified_at is not null`,
      [ownerEmail],
    )
  ).rows;
  if (people.length !== 1) {
    throw new ProvisionRefused("No account has that address verified. Nobody is created here: the owner must already exist.");
  }
  const owner = people[0];
  if (owner.deleted_at !== null) throw new ProvisionRefused("That account is deleted.");
  if (owner.is_service) throw new ProvisionRefused("That is a service account, not a person.");

  // 2. The business, locked while it is checked.
  let createdBusiness = false;
  let recordedOwner = false;
  let business = (
    await db.query(
      `select id, type::text as type, deleted_at, is_agency, owner_user_id
         from organizations where slug = $1 for update`,
      [slug],
    )
  ).rows[0];
  if (!business) {
    business = (
      await db.query(
        `insert into organizations (type, name, slug, owner_user_id)
         values ('client', $1, $2, $3)
         returning id, type::text as type, deleted_at, is_agency, owner_user_id`,
        [name, slug, owner.id],
      )
    ).rows[0];
    createdBusiness = true;
  } else {
    if (business.type !== "client") throw new ProvisionRefused(`The slug "${slug}" belongs to a ${business.type} organization, not a client business.`);
    if (business.deleted_at !== null) throw new ProvisionRefused(`The business "${slug}" is deleted.`);
    if (business.is_agency) throw new ProvisionRefused(`The business "${slug}" is an agency.`);
    if (business.owner_user_id !== null && business.owner_user_id !== owner.id) {
      throw new ProvisionRefused(`The business "${slug}" is recorded as someone else's.`);
    }
    if (business.owner_user_id === null) {
      await db.query(`update organizations set owner_user_id = $2, updated_at = now() where id = $1`, [business.id, owner.id]);
      recordedOwner = true;
    }
  }
  const organizationId = business.id;

  // 3. The owner's membership — the access itself.
  let createdMembership = false;
  const membership = (
    await db.query(`select role::text as role from memberships where organization_id = $1 and user_id = $2`, [organizationId, owner.id])
  ).rows[0];
  if (!membership) {
    await db.query(`insert into memberships (user_id, organization_id, role) values ($1, $2, 'owner')`, [owner.id, organizationId]);
    createdMembership = true;
  } else if (membership.role !== "owner") {
    throw new ProvisionRefused(`The owner already belongs to "${slug}" as ${membership.role}; roles are not changed here.`);
  }

  // 4. Nobody else.
  const check = async (sql, refusal, params = [organizationId]) => {
    const n = (await db.query(sql, params)).rows[0].n;
    if (n !== 0) throw new ProvisionRefused(refusal.replace("{n}", String(n)));
  };
  await check(
    `select count(*)::int as n from memberships where organization_id = $1 and not (user_id = $2 and role = 'owner')`,
    `"${slug}" has {n} other membership(s). It is not private; nothing was changed.`,
    [organizationId, owner.id],
  );
  await check(
    `select count(*)::int as n from invitations
      where organization_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()`,
    `"${slug}" has {n} open invitation(s).`,
  );
  await check(
    `select count(*)::int as n from agency_grants where client_organization_id = $1 and status in ('requested', 'active')`,
    `"${slug}" has {n} agency grant(s) requested or active.`,
  );
  await check(
    `select count(*)::int as n from api_keys where organization_id = $1 and revoked_at is null`,
    `"${slug}" has {n} live API key(s).`,
  );
  await check(
    `select count(*)::int as n from organization_domains where organization_id = $1`,
    `"${slug}" has {n} hostname(s) of its own.`,
  );

  return { organizationId, createdBusiness, createdMembership, recordedOwner };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? "") : "";
  };
  const apply = args.includes("--apply");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL (the owner connection) is not set.");
    process.exit(1);
  }
  const input = {
    name: flag("--name"),
    slug: flag("--slug"),
    ownerEmail: process.env.PROVISION_OWNER_EMAIL || flag("--owner-email"),
  };

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    const result = await provisionBusiness(client, input);
    if (apply) {
      await client.query("commit");
    } else {
      await client.query("rollback");
    }
    const did = [
      result.createdBusiness ? "created the business" : "found the business",
      result.createdMembership ? "made the owner's membership" : "owner's membership already there",
      result.recordedOwner ? "recorded the owner" : null,
    ].filter(Boolean);
    console.log(`${apply ? "Applied" : "Dry run (rolled back)"}: ${did.join("; ")}.`);
    console.log("Verified: one member (the owner, as owner); no open invitations, agency grants, API keys or hostnames.");
    console.log(`Business id: ${result.organizationId}`);
    if (!apply) console.log("Nothing was written. Run again with --apply.");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error instanceof ProvisionRefused) {
      console.error(`Refused: ${error.message}`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
