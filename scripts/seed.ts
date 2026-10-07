import { Client } from "pg";
import { randomUUID } from "node:crypto";

/**
 * Seeds two client companies, one internal company, and one person in each.
 *
 * Two clients rather than one is the point: tenant isolation cannot be
 * demonstrated against a single tenant, because there is nothing to fail to
 * reach. The test in test/isolation.test.ts asks for Northstar's job while
 * scoped to Rotary, using its exact id.
 *
 * Runs as the OWNER connection, which bypasses row-level security — that is
 * what lets a seed write across companies. The application never uses this
 * connection, and refuses to start if it is handed one.
 */

const HOSTS = {
  // Two genuinely different registrable domains. A subdomain pair would prove
  // nothing: sharing a session between two hosts under one domain is ordinary
  // cookie behaviour, not cross-domain sign-in.
  rotary: process.env.SEED_HOST_ROTARY ?? "rotary.portal-b.test:3001",
  northstar: process.env.SEED_HOST_NORTHSTAR ?? "northstar.portal-b.test:3001",
  // The portal (10xid-com/app): a sibling of the login host, as app.10xid.com
  // is of login.10xid.com. It and the client domains above are served by the
  // portal app, on its own port.
  portal: process.env.SEED_HOST_PORTAL ?? "app.portal-a.test:3001",
};

const PEOPLE = {
  staff: { email: "paolo@brandingcentres.test", name: "Paolo (staff)" },
  rotary: { email: "jane@rotary.test", name: "Jane Okafor" },
  northstar: { email: "sam@northstar.test", name: "Sam Reyes" },
};

function uuidv7(): string {
  const bytes = Buffer.from(randomUUID().replace(/-/g, ""), "hex");
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

async function main() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  await db.query(`
    truncate job_events, jobs, sso_tickets, staff_grants, sessions,
             sign_in_codes, memberships, organization_domains, users,
             organizations restart identity cascade
  `);

  const org = async (type: string, name: string, slug: string, hex: string | null) => {
    const { rows } = await db.query(
      `insert into organizations (type, name, slug, brand_primary_hex)
       values ($1,$2,$3,$4) returning id`,
      [type, name, slug, hex],
    );
    return rows[0].id as string;
  };

  const internal = await org("internal", "Branding Centres", "branding-centres", "#26467F");
  const rotary = await org("client", "Rotary", "rotary", "#003F87");
  const northstar = await org("client", "Northstar Roofing", "northstar", "#B5441F");

  const user = async (email: string, name: string, isStaff: boolean) => {
    const { rows } = await db.query(
      `insert into users (email, full_name, is_staff, email_verified_at)
       values ($1,$2,$3, now()) returning id`,
      [email, name, isStaff],
    );
    return rows[0].id as string;
  };

  const staffUser = await user(PEOPLE.staff.email, PEOPLE.staff.name, true);
  const rotaryUser = await user(PEOPLE.rotary.email, PEOPLE.rotary.name, false);
  const northstarUser = await user(PEOPLE.northstar.email, PEOPLE.northstar.name, false);

  const member = (userId: string, orgId: string, role: string) =>
    db.query(
      `insert into memberships (user_id, organization_id, role) values ($1,$2,$3)`,
      [userId, orgId, role],
    );

  await member(staffUser, internal, "staff");
  await member(rotaryUser, rotary, "owner");
  await member(northstarUser, northstar, "owner");

  const domain = (orgId: string, hostname: string) =>
    db.query(
      `insert into organization_domains (organization_id, hostname, is_primary, verified_at)
       values ($1,$2,true, now())`,
      [orgId, hostname.toLowerCase()],
    );

  await domain(rotary, HOSTS.rotary);
  await domain(northstar, HOSTS.northstar);
  await domain(internal, HOSTS.portal);

  const job = async (
    orgId: string,
    ref: string,
    title: string,
    direction: string,
    createdBy: string,
    status = "open",
  ) => {
    const id = uuidv7();
    await db.query(
      `insert into jobs (id, organization_id, ref, direction, title, status, created_by)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, orgId, ref, direction, title, status, createdBy],
    );
    await db.query(
      `insert into job_events (job_id, organization_id, actor_id, actor_email_at_time, action, after)
       values ($1,$2,$3,$4,'created',$5)`,
      [id, orgId, createdBy, PEOPLE.staff.email, JSON.stringify({ title, status })],
    );
    return id;
  };

  const rotaryJob = await job(rotary, "ROT-0001", "District 7070 banner artwork", "from_client", rotaryUser);
  await job(rotary, "ROT-0002", "Club pin proof — second round", "to_client", staffUser, "in_progress");
  const northstarJob = await job(northstar, "NOR-0001", "Fleet vehicle wrap — 3 vans", "from_client", northstarUser);
  await job(northstar, "NOR-0002", "Site hoarding panels", "to_client", staffUser);

  await db.query(`update organizations set job_counter = 2 where type = 'client'`);

  await db.end();

  console.log("Seeded.\n");
  console.log("  Branding Centres (internal)");
  console.log(`    ${PEOPLE.staff.email}  — staff, sees every client`);
  console.log(`\n  Rotary  → https://${HOSTS.rotary}`);
  console.log(`    ${PEOPLE.rotary.email}  — sees Rotary's jobs only`);
  console.log(`    job ROT-0001 id: ${rotaryJob}`);
  console.log(`\n  Northstar Roofing  → https://${HOSTS.northstar}`);
  console.log(`    ${PEOPLE.northstar.email}  — sees Northstar's jobs only`);
  console.log(`    job NOR-0001 id: ${northstarJob}`);
  console.log(
    `\n  The isolation test asks for NOR-0001 by that exact id while signed in as ${PEOPLE.rotary.email}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
