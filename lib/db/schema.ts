import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  char,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Secrets are stored as the SHA-256 of the value we handed out, never the value
 * itself. Reading this database therefore yields no usable session cookie, no
 * sign-in code and no handoff ticket.
 */
const sha256 = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

export const organizationType = pgEnum("organization_type", [
  "client",
  "internal",
]);
export const membershipRole = pgEnum("membership_role", [
  "owner",
  "member",
  "staff",
]);
/**
 * Can people inside one organization see each other at all?
 *
 * `closed` is the default and the interesting case. An agency does not want
 * its client meeting the contractor doing the work, and a company of two
 * hundred does not want a new starter able to enumerate everybody. So being
 * in the same organization grants NOTHING on its own — visibility comes from
 * an explicit connection, and the admin decides whether membership creates
 * one automatically.
 */
export const memberVisibility = pgEnum("member_visibility", ["open", "closed"]);

/** Why two people can see each other. Kept because "how" changes what may be revoked. */
export const connectionSource = pgEnum("connection_source", [
  /** The organization is `open`, so membership alone did it. */
  "org_open",
  /** One invited the other, or an admin put them together. */
  "invitation",
  /** They scanned each other's iD — the two people were in a room. */
  "id_scan",
  /** They ended up on the same piece of work. */
  "shared_work",
  /** Someone with the authority simply said so. */
  "manual",
]);

/** What a granted capability applies TO. */
export const permissionScope = pgEnum("permission_scope", [
  "organization",
  "department",
  "task_type",
  "task",
  "user",
]);

export const jobDirection = pgEnum("job_direction", [
  "from_client",
  "to_client",
]);
export const jobStatus = pgEnum("job_status", [
  "draft",
  "open",
  "in_progress",
  "awaiting_approval",
  "changes_requested",
  "approved",
  "completed",
  "cancelled",
]);

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: organizationType("type").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** Per-client theme tokens, applied by hostname. Never authorisation. */
  brandPrimaryHex: text("brand_primary_hex"),
  brandLogoUrl: text("brand_logo_url"),
  /**
   * Per-client counter behind the human job reference (ROT-0042). Incremented
   * atomically in the same statement that reads it, so two people raising a job
   * at the same moment cannot be handed the same number.
   */
  jobCounter: integer("job_counter").notNull().default(0),
  /**
   * Whether belonging to this organization lets you see the other people in
   * it. Defaults to `closed` — the safe answer, and the one an agency needs.
   */
  memberVisibility: memberVisibility("member_visibility")
    .notNull()
    .default("closed"),
  /**
   * The person answerable for this organization. Set when a brand is created,
   * and the reason a brand can be handed over: selling one is transferring
   * this, not migrating anybody's account.
   */
  ownerUserId: uuid("owner_user_id"),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * Which hostname belongs to which company. This drives BRANDING and ROUTING
 * only. What a person may read comes from their session and membership — the
 * host a request arrived on carries no authority whatsoever.
 *
 * It is also the allowlist the cross-domain handoff redeems against: a return
 * destination is the id of a row in this table, never a URL, which makes an
 * open redirect structurally impossible rather than carefully guarded.
 */
export const organizationDomains = pgTable(
  "organization_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** Stored lowercase, including port in development. */
    hostname: text("hostname").notNull().unique(),
    isPrimary: boolean("is_primary").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("organization_domains_org_idx").on(t.organizationId)],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Stored lowercase. The identity — there is no password column. */
  email: text("email").notNull().unique(),
  fullName: text("full_name"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  /** Derived from membership of the internal organization; stored for speed. */
  isStaff: boolean("is_staff").notNull().default(false),
  /**
   * A service account: the identity an API key acts as, so automated work is
   * attributable to a named thing rather than to a person's login.
   *
   * It is a real row in this table on purpose — a job raised by Northstar's
   * website has the same shape as one raised by a person, so nothing downstream
   * needs a second code path. What it must never do is sign in: the sign-in
   * route refuses these accounts outright, so possession of the mailbox (there
   * is none — the address is on a .invalid domain) would still achieve nothing.
   */
  isService: boolean("is_service").notNull().default(false),
  /**
   * TOTP shared secret, encrypted at rest with AES-256-GCM. A database dump
   * therefore yields no working second factor — which is the whole point of
   * having one, since the first factor already lives in an inbox.
   */
  totpSecret: text("totp_secret"),
  totpConfirmedAt: timestamp("totp_confirmed_at", { withTimezone: true }),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * An address is a CLAIM attached to an account, never the account itself.
 *
 * The obvious design puts one `email` column on the person, and it is wrong in
 * two ways that only surface once there are real users. People change
 * addresses — and if the address IS the identity, changing it either forks the
 * account or quietly rewrites who did what. Worse, shared mailboxes are normal
 * in this trade: `orders@club.org` is one address and frequently several
 * humans, and `jane@club.org` arriving two years later is the same person who
 * used to be `orders@`.
 *
 * So addresses live here — many per account, each verified on its own — and
 * signing in resolves THROUGH this table. One address is marked primary,
 * because outbound mail needs a single answer, and a partial unique index
 * enforces exactly one per account rather than trusting every writer to.
 *
 * `email` is unique across the whole table, which is what stops two accounts
 * claiming the same address and gives "who is this?" one answer at sign-in.
 */
export const userEmails = pgTable(
  "user_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** Stored lowercase. Unique across every account, not merely per account. */
    email: text("email").notNull().unique(),
    /**
     * Where mail goes. Exactly one per account, enforced by a partial unique
     * index in the migration — Drizzle cannot express `WHERE is_primary`, and a
     * plain unique index here would permit only one NON-primary address too.
     */
    isPrimary: boolean("is_primary").notNull().default(false),
    /**
     * Verified independently of every other address. An unverified address can
     * be claimed but cannot be signed in with, so adding somebody else's
     * address to your account achieves nothing.
     */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("user_emails_user_idx").on(t.userId)],
);

/**
 * The iD — and the reason it is a table rather than a column on `users`.
 *
 * Everybody who signs in anywhere gets an ACCOUNT. Far fewer will hold an iD:
 * it is issued deliberately, it can be given up, and it may one day be
 * transferred. Those are all things that happen TO an identifier, and none of
 * them should be able to reach the account's history.
 *
 * Hence the rule this table exists to make enforceable: NOTHING references
 * `id_code`. Jobs, memberships, audit rows and sessions all point at
 * `users.id`, a uuid that never changes for the life of the account.
 * Transferring an iD therefore moves one row and rewrites nothing. Were a job
 * ever to record "assigned to 10X-4K7P2" instead of the account uuid, a
 * transfer would silently reassign that job's history to whoever holds the code
 * next — and the evidence of the previous holder is exactly what would be
 * overwritten, so it could not be detected afterwards, let alone undone.
 *
 * Two constraints carry the model, both in the database, because neither
 * survives being a convention:
 *
 *   * at most ONE live iD per account — a partial unique index on user_id
 *     where revoked_at is null, so revoked ones do not block a reissue;
 *   * an id_code is unique FOREVER, revoked rows included, so a code that was
 *     once somebody's can never be handed to somebody else.
 */
export const identities = pgTable(
  "identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /**
     * The public identifier. Unique across every row this table has ever held,
     * including revoked ones — see above.
     *
     * Deliberately NOT a foreign key target anywhere in this schema.
     */
    idCode: text("id_code").notNull().unique(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set rather than deleted, so "was issued and given up" stays a fact. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [index("identities_user_idx").on(t.userId)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    role: membershipRole("role").notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("memberships_user_org_idx").on(t.userId, t.organizationId),
    index("memberships_org_idx").on(t.organizationId),
  ],
);

/**
 * A subdivision of an organization — marketing, graphic design, the shop floor.
 *
 * Departments exist because "who may see this" is usually answered by team
 * rather than by person. Granting a capability to a department and moving
 * people in and out of it is the difference between administering a company
 * of twenty and administering one of two hundred.
 */
export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt,
    updatedAt,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("departments_org_slug_idx").on(t.organizationId, t.slug),
    index("departments_org_idx").on(t.organizationId),
  ],
);

export const departmentMembers = pgTable(
  "department_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    createdAt,
  },
  (t) => [
    uniqueIndex("department_members_dept_user_idx").on(t.departmentId, t.userId),
    index("department_members_user_idx").on(t.userId),
  ],
);

/**
 * Who can see whom.
 *
 * The rule this table exists to enforce: **people are invisible to each other
 * until something makes them visible.** Sharing an employer is not that
 * something, and neither is sharing a job — both are decisions an admin makes,
 * not facts the database should assume.
 *
 * The worked example this was designed against. Tom is one of eighteen
 * designers. John, a marketing head, sends a booth to Jane, who micromanages:
 * everything routes through her, so John and Tom never need to see each other.
 * John sends a banner to Sam, who works the other way: she picks Tom and steps
 * back, so John and Tom DO need to see each other, and only for that job. Same
 * company, same two people, opposite answers — which is why this cannot be
 * derived from membership and has to be recorded.
 *
 * A pair is stored ONCE, with the lower uuid in `a_user_id`. Seeing is mutual:
 * there is no direction in which Tom can see John but John cannot see Tom, and
 * a two-row design would eventually hold exactly that contradiction.
 *
 * Revoked rather than deleted, because "we were connected and no longer are"
 * is a different fact from "we never were", and the first one explains why
 * somebody can still see a task they were part of.
 */
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The organization this connection lives inside, or NULL when two people
     * simply know each other — the QR-scan case. A personal connection is not
     * an organization's to revoke, and outlives anybody's employment.
     */
    organizationId: uuid("organization_id").references(() => organizations.id),
    /** Always the numerically lower uuid of the pair. Enforced by a check. */
    aUserId: uuid("a_user_id")
      .notNull()
      .references(() => users.id),
    bUserId: uuid("b_user_id")
      .notNull()
      .references(() => users.id),
    source: connectionSource("source").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt,
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("connections_a_idx").on(t.aUserId),
    index("connections_b_idx").on(t.bUserId),
    index("connections_org_idx").on(t.organizationId),
  ],
);

/**
 * What somebody may do, stored as data rather than written as code.
 *
 * `capability` is deliberately free text — "task.create", "person.see",
 * "task.approve", whatever tomorrow needs. Adding a capability is inserting a
 * row, not shipping a migration and a deploy. That is the whole point: roles
 * that cannot be invented after the fact are roles that stop fitting the
 * business within a year, and this business intends to keep refining them
 * indefinitely.
 *
 * `scopeType` and `scopeId` say what it applies to: the whole organization, a
 * department, a kind of work, one specific task, or one specific person. So
 * "Sam may assign graphic design work" and "Tom may see John, but only on the
 * banner" are the same shape of row.
 *
 * The three coarse roles on `memberships` stay. They are the sensible default
 * a new member arrives with; this table is how that default gets narrowed or
 * widened afterwards without inventing a new role each time.
 */
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    capability: text("capability").notNull(),
    scopeType: permissionScope("scope_type").notNull(),
    /** Null when the scope is the organization itself. */
    scopeId: uuid("scope_id"),
    /**
     * Grants are positive by default. A DENY wins over any grant, so one row
     * can carve a person out of something their department was given — which
     * is otherwise only expressible by taking the grant off the department and
     * re-granting it to everybody else one at a time.
     */
    deny: boolean("deny").notNull().default(false),
    /**
     * HOW MUCH of the capability, when "may they" is not a yes or no.
     *
     * A qualification is the case that forced it: somebody is in training at
     * digitising, qualified at quoting and a trainer at vectorising, all at
     * once. A boolean cannot say that, and a second `qualifications` table
     * would be a parallel permission system — two places answering "may Tom
     * digitise", which eventually answer it differently, and only one of which
     * the deny rule applies to.
     *
     * So it is a column here: capability `task.perform`, scope `task_type`,
     * level 1 training / 2 qualified / 3 trainer. NULL on every ordinary grant,
     * which means exactly what it did before this column existed — the
     * capability is held, and it has no degrees.
     *
     * See lib/db/access.ts: QUALIFICATION_LEVELS, qualify(), qualificationLevel().
     */
    level: integer("level"),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id),
    createdAt,
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("permissions_user_idx").on(t.userId, t.organizationId),
    index("permissions_org_capability_idx").on(t.organizationId, t.capability),
  ],
);

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

/**
 * Two clocks, both enforced here rather than in the cookie:
 *   idleSeconds       — restarts on every visit. Null means no idle timeout.
 *   absoluteExpiresAt — renewal can never push past it.
 *
 * Both are COPIED ONTO THE ROW at creation, so promoting someone to staff
 * tomorrow does not retroactively stretch a session that is already live.
 *
 * Liveness is decided from this row, never from the cookie's own expiry — a
 * browser can keep sending an expired cookie indefinitely.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: sha256("token_hash").notNull().unique(),
    /** The one host this cookie lives on. Each domain gets its own session. */
    issuedForHost: text("issued_for_host").notNull(),
    createdAt,
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    idleSeconds: integer("idle_seconds"),
    absoluteExpiresAt: timestamp("absolute_expires_at", {
      withTimezone: true,
    }).notNull(),
    roleAtCreation: text("role_at_creation").notNull(),
    /**
     * When this session passed its second factor. Null on a staff session means
     * the email code has been accepted and nothing else — it can reach the
     * enrolment screen and nothing else.
     */
    secondFactorAt: timestamp("second_factor_at", { withTimezone: true }),
    /** Staff only: the client they are currently acting on. */
    activeOrganizationId: uuid("active_organization_id").references(
      () => organizations.id,
    ),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * The login-host session this one was handed over from, or null for a
     * session signed in to directly. Together they are one browser — one
     * device — holding a session on each host it has visited, so "sign out
     * here" ends the pair rather than leaving the login host to sign this host
     * straight back in. See 0020.
     */
    sourceSessionId: uuid("source_session_id").references(
      (): AnyPgColumn => sessions.id,
    ),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    index("sessions_source_session_idx").on(t.sourceSessionId),
  ],
);

export const signInCodes = pgTable(
  "sign_in_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    codeHash: sha256("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    requestedIp: text("requested_ip"),
    createdAt,
  },
  (t) => [index("sign_in_codes_email_idx").on(t.email)],
);

/**
 * How somebody comes to have an account at all.
 *
 * There is no open registration, and this is the reason the sign-up screen can
 * exist without one: a portal is a set of separate companies' data, and an
 * address typed into a form carries nothing that says which company it belongs
 * to. Guessing would be the whole tenancy model decided by a stranger.
 *
 * So an account starts here instead. Somebody who already has access names an
 * address and a company, and the invitation is what the sign-up screen checks
 * against. Until it is accepted there is no user row — an invitation on its own
 * grants nothing and can be withdrawn.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stored lowercase, matched exactly. */
    email: text("email").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    role: membershipRole("role").notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index("invitations_email_idx").on(t.email),
    index("invitations_org_idx").on(t.organizationId),
  ],
);

/**
 * The way back in when the authenticator is gone.
 *
 * Once an account holds a confirmed authenticator, the emailed code stops
 * working for it — otherwise anyone holding the inbox could simply ignore the
 * authenticator, and it would be decorative. That is the right trade, but it
 * means a lost or wiped phone is a permanent lockout unless something else
 * exists. These are that something else.
 *
 * Ten codes, issued at enrolment, shown once and stored only as hashes. Each
 * works exactly once, consumed by an atomic update, so a list photographed over
 * a shoulder is worth less with every code that gets used.
 */
export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    codeHash: sha256("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);

/**
 * The cross-domain handoff, shaped as an OAuth authorization code.
 *
 * Opaque 32 random bytes, stored hashed, valid for seconds, redeemable exactly
 * once by an atomic update, bound to ONE destination host, and tied to the
 * session that minted it so signing out kills tickets still in flight.
 */
export const ssoTickets = pgTable(
  "sso_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketHash: sha256("ticket_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** The only host permitted to redeem this ticket. */
    audienceHost: text("audience_host").notNull(),
    /** A path within that host. Never a full URL, never cross-host. */
    returnPath: text("return_path").notNull().default("/"),
    sourceSessionId: uuid("source_session_id")
      .notNull()
      .references(() => sessions.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("sso_tickets_session_idx").on(t.sourceSessionId)],
);

/**
 * Staff do not get ambient power over every client. They exchange their
 * identity for a time-boxed grant to ONE client, carrying a reason typed at the
 * moment of switching — so the audit line says which client was opened and why,
 * not merely that an admin was active.
 */
export const staffGrants = pgTable(
  "staff_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => users.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    reason: text("reason").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
  },
  (t) => [index("staff_grants_session_idx").on(t.sessionId)],
);

/**
 * Acting as somebody else.
 *
 * The same shape as `staff_grants` above, and deliberately so: staff already
 * trade their identity for a time-boxed, reasoned, logged grant to one CLIENT,
 * and this is the same trade for one PERSON. Modelling it any other way would
 * have produced a second kind of elevated access with its own rules, which is
 * how one of them ends up with weaker ones.
 *
 * What it is FOR: Flow looks different from each side, and the only way to see
 * a client's side is to be them. Signing in as them is impossible by design —
 * the code goes to their real inbox — and asking them for it would be asking
 * for their credential.
 *
 * What separates it from a back door is written into the columns:
 *
 *   * `session_id` — a grant belongs to ONE browser session. It cannot be
 *     picked up by another login, and ending that session ends it.
 *   * `actor_user_id` — the real person. Never overwritten by the target, and
 *     the identity every check is made against.
 *   * `target_user_id` — who they appear as.
 *   * `reason` — typed at the moment of starting, minimum eight characters,
 *     the same floor `staff_grants` uses. This table IS the audit, so a row
 *     without a reason would be a row that cannot answer why.
 *   * `expires_at` — sixty minutes, renewed by starting another one rather
 *     than by extending this row, so each stretch keeps its own reason.
 *   * `ended_at` — set when it is given up. Distinct from `expires_at` on
 *     purpose: "given up at 14:12" and "lapsed at 15:00" are different facts,
 *     and `staff_grants` cannot tell them apart because it stamps expires_at
 *     to end early. A live grant is one with no ended_at whose expires_at is
 *     still in the future.
 *
 * Nothing is deleted. The application role holds no DELETE on this table.
 */
export const actAsGrants = pgTable(
  "act_as_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The one browser session this grant is attached to. */
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    /** The real person. Every permission check is made against this account. */
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    /** Who they are appearing as. */
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set when given up. Null while it is still running or has merely lapsed. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("act_as_grants_session_idx").on(t.sessionId),
    index("act_as_grants_actor_idx").on(t.actorUserId),
    index("act_as_grants_target_idx").on(t.targetUserId),
  ],
);

/**
 * Keys for machines.
 *
 * A client's own website has work to hand over — Northstar's estimate requests —
 * and there is no person behind that request to sign in. The alternative people
 * reach for is to let the automation use someone's personal login, which means
 * one leaked credential is both a human's whole account and every script that
 * ever borrowed it. So a key is its own credential:
 *
 *   * bound to ONE company, which is where its jobs land, and to a service
 *     account, which is who they are attributed to;
 *   * stored as a hash, so this table leaks nothing if it is read;
 *   * write-only in what it can do — there is no read endpoint behind it, so a
 *     stolen key can file work, not extract it;
 *   * revocable on its own, without touching anybody's login.
 *
 * `prefix` is the first few characters of the key, kept in clear. It is not a
 * secret and cannot be used to authenticate; it exists so a key can be told
 * apart from its siblings in a list, and so a leaked key found in a log can be
 * matched to a row and revoked.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** The service account jobs filed with this key are attributed to. */
    serviceUserId: uuid("service_user_id")
      .notNull()
      .references(() => users.id),
    /** What this key is for, in words: "Northstar website — estimate form". */
    label: text("label").notNull(),
    keyHash: sha256("key_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt,
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_keys_org_idx").on(t.organizationId)],
);

/* ------------------------------------------------------------------ */
/* The work                                                            */
/* ------------------------------------------------------------------ */

/**
 * `id` is a UUIDv7 generated in application code — time-ordered so the index
 * does not fragment, with 74 random bits so it cannot be walked. Postgres 16
 * has no native uuidv7(), so there is deliberately no database default: the
 * caller must supply one.
 *
 * `ref` (ROT-0042) is the human label. It is per-client sequential and so
 * leaks how many jobs a client has — which is why it NEVER appears in a URL.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    ref: text("ref").notNull(),
    direction: jobDirection("direction").notNull(),
    title: text("title").notNull(),
    status: jobStatus("status").notNull().default("open"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    assignedTo: uuid("assigned_to").references(() => users.id),
    dueAt: timestamp("due_at", { withTimezone: true }),
    /**
     * THE CLIENT'S CLOCK, and the only one they ever see.
     *
     * Deliberately generous and deliberately not derived from anything: an
     * hour's work is promised for tomorrow, three weeks' work is promised in
     * five. The slack between this and the worker's window
     * (`tasks.std_minutes` + `tasks.buffer_minutes`) is commercial safety and
     * belongs to the business, not to the worker.
     *
     * It is a separate column rather than a formula over the tasks because
     * conflating the two clocks is a real bug in both directions: promise the
     * client the worker's deadline and one slow touch is a broken promise;
     * give the worker the client's deadline and a fifteen-minute job can wait
     * until Tuesday. The buffer bands apply ONLY to the worker's window.
     */
    promisedAt: timestamp("promised_at", { withTimezone: true }),

    // Phase 2 — commercial. Defined now so the shape is agreed.
    poNumber: text("po_number"),
    quotedAmountCents: integer("quoted_amount_cents"),
    currency: char("currency", { length: 3 }),

    /**
     * Where this job's files live in Google Drive.
     *
     * A reference, not a copy: the portal records which folder belongs to which
     * job and nothing else. Drive stays the place the files are, so nobody has
     * to wonder which of two systems has the current version.
     *
     * Null until somebody asks for a folder. Creating one is deliberately an
     * action rather than something that happens to every request that arrives,
     * because most enquiries never become work and a Drive full of empty
     * folders is worse than no folders.
     */
    driveFolderId: text("drive_folder_id"),
    driveFolderUrl: text("drive_folder_url"),

    createdAt,
    updatedAt,
    /** The archive is a timestamp, not a second table to forget to scope. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("jobs_org_ref_idx").on(t.organizationId, t.ref),
    index("jobs_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

/**
 * Append-only. UPDATE and DELETE are revoked from the application role in the
 * migration, so this is enforced by the database rather than by convention.
 */
export const jobEvents = pgTable(
  "job_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** Null for system actions. */
    actorId: uuid("actor_id").references(() => users.id),
    /** Email can change later; the record of who acted must not. */
    actorEmailAtTime: text("actor_email_at_time").notNull(),
    /**
     * The three columns below are the other half of `actor_id`, and they are
     * null on every ordinary row.
     *
     * While somebody is acting as somebody else, `actor_id` stays the person
     * the work was done AS — that is the point of the feature, and a client's
     * own history should read as their own work rather than as a stranger
     * rummaging in it. What that alone cannot say is that a human other than
     * the named one was at the keyboard. These say it.
     *
     * Null therefore means something exact: this was real work, done by the
     * person named in `actor_id`. Non-null means it was done while acting as
     * them, by `real_actor_id`, under the grant in `act_as_grant_id` — whose
     * row carries the reason that was typed. Six months from now that is the
     * difference between test data and a client's real history, and it cannot
     * be reconstructed later if it is not written now.
     *
     * `real_actor_email_at_time` is kept for the same reason
     * `actor_email_at_time` is: an address can change, and the record of who
     * acted must not.
     */
    realActorId: uuid("real_actor_id").references(() => users.id),
    realActorEmailAtTime: text("real_actor_email_at_time"),
    actAsGrantId: uuid("act_as_grant_id").references(() => actAsGrants.id),
    action: text("action").notNull(),
    /** Field-level diff, not a whole-row dump. */
    before: jsonb("before"),
    after: jsonb("after"),
    /** The server's clock, never the client's. */
    createdAt,
  },
  (t) => [index("job_events_job_idx").on(t.jobId)],
);

/**
 * Every table that belongs to a client carries `organization_id` directly —
 * deliberately denormalised — so the scoping helper and the database policies
 * apply one identical filter to every table with no joins.
 */
export const TENANT_SCOPED_TABLES = [
  "jobs",
  "job_events",
  "api_keys",
  "invitations",
  "task_types",
  "tasks",
  "task_offers",
  "task_claims",
  "task_grades",
  "task_events",
] as const;

/* ------------------------------------------------------------------ */
/* Flow — the spine                                                    */
/* ------------------------------------------------------------------ */

/**
 * What kind of touch this is: a task's state, not a job's.
 *
 * `open` means claimable. `claimed` means one person holds it and a clock is
 * running against them. A claim that is released or times out puts the row
 * back to `open` — the task does not remember the attempt, because the attempt
 * is a row in `task_claims` and remembering it twice is how the two come to
 * disagree.
 *
 * There is no `rejected` state that a row recovers from. A task graded
 * unsatisfactory is finished; the second attempt is a NEW row pointing at it
 * through `parent_task_id`. That is what makes the rework chain walkable, and
 * the separation-of-duty trigger depends on being able to walk it.
 */
export const taskStatus = pgEnum("task_status", [
  "draft",
  "open",
  "claimed",
  "submitted",
  "approved",
  "rejected",
  "cancelled",
]);

/**
 * Who a task is offered to. One of three shapes, never two at once.
 *
 * `qualification` is the interesting one: not "these named people" but
 * "anybody at level N or above at this kind of work", resolved at claim time
 * against `permissions`. Offering to a qualification rather than to a list is
 * what lets the pool grow without anybody editing offers.
 */
export const taskOfferee = pgEnum("task_offeree", [
  "user",
  "department",
  "qualification",
]);

/**
 * How an attempt ended. NULL while it is still running.
 *
 * `released` and `expired` are deliberately different facts, and the
 * difference is the whole incentive design rather than bookkeeping. A worker
 * who knows at minute three that they cannot finish should hand the job back
 * so somebody else still has the standard time to do it. They will only do
 * that if handing it back is recorded — and costs — differently from sitting
 * on it silently until the clock runs out. If the two collapse into one
 * outcome there is no reason to ever release: you may as well hope.
 */
export const claimOutcome = pgEnum("claim_outcome", [
  /** Handed in. The work exists and is waiting to be graded. */
  "submitted",
  /** Given back on purpose, before the clock ran out. */
  "released",
  /** The clock ran out. The claim was pulled; the work returns to the pool. */
  "expired",
]);

/**
 * Satisfactory or not. Technical work: the file either works or it does not.
 *
 * The verdict is binary and the score beside it is optional, because creative
 * work is coming and grades on a rubric. Carrying the optional score now costs
 * nothing and means creative work does not need a second grading system bolted
 * on beside this one.
 */
export const gradeVerdict = pgEnum("grade_verdict", [
  "satisfactory",
  "unsatisfactory",
]);

/**
 * The buffer bands, as DATA.
 *
 * A worker's window is the standard time for the kind of work plus a buffer,
 * so somebody can answer the door without losing the job. 5/10/15 is a first
 * guess that will be revised once real people have been watched working — and
 * a guess that lives in a CASE statement inside a function is a guess that
 * needs a migration and a deploy to revise. So it lives here, one row per
 * band, and revising it is an UPDATE.
 *
 * Revising it also must not move work that is already in flight, which is why
 * `tasks` copies the answer onto itself at creation and never reads this table
 * again. See `flow_pin_allowed_time()` in the migration.
 *
 * Bounds are half-open: `min_std_minutes` inclusive, `max_std_minutes`
 * exclusive, NULL meaning unbounded. Live bands may not overlap — enforced by
 * an exclusion constraint, because two bands covering 25 minutes is not a
 * preference, it is a question with two answers.
 *
 * NOT tenant data: this is the house's policy about its own workers, the same
 * in every client's jobs, and it carries no organization_id on purpose.
 */
export const taskTimeBands = pgTable("task_time_bands", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Inclusive. */
  minStdMinutes: integer("min_std_minutes").notNull(),
  /** Exclusive. NULL means "and everything above". */
  maxStdMinutes: integer("max_std_minutes"),
  bufferMinutes: integer("buffer_minutes").notNull(),
  /** Why this band is what it is, for the next person who wants to change it. */
  note: text("note"),
  createdAt,
  updatedAt,
  /** Retired rather than deleted — a band that was in force is a fact. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * A kind of work: quote, digitize, approve, print, embroider.
 *
 * `stdMinutes` is the standard time — how long this kind of touch is expected
 * to take, in minutes, the smallest unit this system has. It is the input to
 * the worker's window and NOT a promise to the client; see `jobs.promisedAt`,
 * which is a different clock entirely and deliberately generous.
 *
 * Per organization, because the same word means different work at different
 * clients and because a standard time is exactly the kind of number that gets
 * tuned per client once real jobs have run.
 */
export const taskTypes = pgTable(
  "task_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** Stable machine name: "digitize". Unique per organization. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * The standard time in minutes. Copied onto every task at creation, so
     * revising it here never moves work in flight — and revising it is
     * expected, since an extension granted because "our estimate was wrong" is
     * precisely the signal that this number is too low.
     */
    stdMinutes: integer("std_minutes").notNull(),
    createdAt,
    updatedAt,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("task_types_org_slug_idx").on(t.organizationId, t.slug),
    index("task_types_org_idx").on(t.organizationId),
  ],
);

/**
 * ONE TOUCH — one paid act by one person.
 *
 * The unit of work is not the job. Digitising a cap logo is three touches —
 * quote, digitize, approve — each with its own holder, its own clock and its
 * own state. One person may hold several; they simply hold several rows.
 *
 * `id` is a UUIDv7 supplied by the caller, the same as `jobs`: time-ordered so
 * the index does not fragment, random enough not to be walked, and with no
 * database default because Postgres 16 has no native uuidv7().
 *
 * THE TWO CLOCKS. `stdMinutes` and `bufferMinutes` are the worker's, pinned
 * here at creation from the task type and from `task_time_bands`, and
 * `allowedMinutes` is their sum. `jobs.promisedAt` is the client's, and it is
 * deliberately generous — an hour's work promised for tomorrow. The slack
 * between them is commercial safety that belongs to the business. Conflating
 * them would either promise the client a deadline a worker is not being paid
 * to hit, or give a worker until Tuesday for a fifteen-minute job.
 *
 * `approvesTaskId` is what makes a touch an approval touch: it names the task
 * this one reviews. It is not decoration — the separation-of-duty trigger
 * reads it to work out whether an incoming claim is somebody offering to
 * inspect work, and whose.
 *
 * `parentTaskId` is the rework chain. A task graded unsatisfactory is
 * finished; the retry is a new row pointing back at it. The chain is walked by
 * the same trigger, because the second attempt has no memory of who rejected
 * the first and an approver who could claim the rework would be paid twice for
 * rejecting it once.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    taskTypeId: uuid("task_type_id")
      .notNull()
      .references(() => taskTypes.id),
    status: taskStatus("status").notNull().default("open"),
    title: text("title"),
    /**
     * The attempt this row replaces. NULL for a first attempt.
     * Walked upward by the separation-of-duty trigger.
     */
    parentTaskId: uuid("parent_task_id"),
    /**
     * The task this one exists to inspect. NULL unless this is an approval
     * touch. Its presence is what puts an incoming claim on the reviewing side
     * of the separation-of-duty rule.
     */
    approvesTaskId: uuid("approves_task_id"),
    /**
     * PINNED AT CREATION from `task_types.std_minutes`. Never read back from
     * the type, so retuning the type cannot move work in flight.
     */
    stdMinutes: integer("std_minutes").notNull(),
    /**
     * PINNED AT CREATION from `task_time_bands`. Same discipline as price:
     * change the bands next month and nothing already created moves.
     */
    bufferMinutes: integer("buffer_minutes").notNull(),
    /**
     * The worker's whole window, in minutes. A stored generated column rather
     * than a number somebody remembers to keep in step.
     */
    allowedMinutes: integer("allowed_minutes")
      .notNull()
      .generatedAlwaysAs(sql`std_minutes + buffer_minutes`),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt,
    updatedAt,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("tasks_org_status_idx").on(t.organizationId, t.status),
    index("tasks_job_idx").on(t.jobId),
    index("tasks_parent_idx").on(t.parentTaskId),
    index("tasks_approves_idx").on(t.approvesTaskId),
  ],
);

/**
 * Who a task is available to.
 *
 * Three shapes in one table, because "offered to Tom", "offered to the
 * digitising department" and "offered to anybody qualified at digitising" are
 * the same event with different audiences, and splitting them into three
 * tables would mean three code paths for "what may I claim".
 *
 * Exactly one of the three targets is set, enforced by a check constraint in
 * the migration rather than by whoever writes the next insert.
 *
 * Withdrawn rather than deleted: an offer that was live and was pulled back
 * explains why somebody saw a task yesterday and cannot see it today.
 */
export const taskOffers = pgTable(
  "task_offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    offereeType: taskOfferee("offeree_type").notNull(),
    /** Set when offeree_type = 'user'. */
    userId: uuid("user_id").references(() => users.id),
    /** Set when offeree_type = 'department'. */
    departmentId: uuid("department_id").references(() => departments.id),
    /**
     * Set when offeree_type = 'qualification': the kind of work somebody must
     * be qualified at, and the level they must hold. The level is resolved
     * against `permissions` at claim time — see lib/db/access.ts. It is not a
     * second qualifications table, because two places that answer "is Tom
     * qualified" eventually answer it differently.
     */
    qualificationTaskTypeId: uuid("qualification_task_type_id").references(
      () => taskTypes.id,
    ),
    /** 1 training, 2 qualified, 3 trainer. See QUALIFICATION_LEVELS. */
    minQualificationLevel: integer("min_qualification_level"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt,
    /** Pulled back. The offer having existed stays a fact. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("task_offers_task_idx").on(t.taskId),
    index("task_offers_user_idx").on(t.userId),
    index("task_offers_department_idx").on(t.departmentId),
    index("task_offers_qualification_idx").on(t.qualificationTaskTypeId),
  ],
);

/**
 * ONE ROW PER ATTEMPT. Not a status on the task.
 *
 * A task claimed, released, then reclaimed by somebody else must leave three
 * distinguishable facts behind, and a `claimed_by` column on `tasks` leaves
 * one — the last one — overwriting the evidence of everything before it. That
 * evidence is the entire input to "is this person reliable", which is the
 * question the extension policy and the qualification levels both turn on.
 *
 * `expiresAt` is this attempt's deadline, stamped from the task's PINNED
 * allowed minutes at the moment of claiming. It is on the claim rather than on
 * the task because a second attempt gets its own full window, not the remains
 * of somebody else's.
 *
 * `outcome` NULL means the attempt is still running. At most one such row per
 * task exists at a time, enforced by a partial unique index — which is also
 * the thing that makes the claim race safe to lose.
 */
export const taskClaims = pgTable(
  "task_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Stamped from the task's pinned allowed minutes when the claim is made. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** NULL while it is still running. */
    outcome: claimOutcome("outcome"),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
    /** What they said when they handed it back. */
    note: text("note"),
    createdAt,
  },
  (t) => [
    index("task_claims_task_idx").on(t.taskId),
    index("task_claims_user_idx").on(t.userId),
  ],
);

/**
 * Satisfactory or not, with an optional score and a note.
 *
 * A verdict is attached to the ATTEMPT as well as the task, because two
 * attempts at the same task get two grades and a grade that could not say
 * which attempt it was about would be unable to answer the only question it
 * exists to answer.
 *
 * Several grades per attempt is normal rather than exceptional: everybody
 * starts in training, and during training two people do the same work
 * independently so that agreement — rather than a conscientious 25-cent
 * approver — is what measures them.
 *
 * INSERTING A ROW HERE IS AN ACT OF APPROVAL, and the separation-of-duty
 * trigger treats it as one: the grader may not be the person who did the work
 * and may not be at their company.
 */
export const taskGrades = pgTable(
  "task_grades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    /** The attempt being graded. */
    claimId: uuid("claim_id").references(() => taskClaims.id),
    graderUserId: uuid("grader_user_id")
      .notNull()
      .references(() => users.id),
    verdict: gradeVerdict("verdict").notNull(),
    /**
     * Optional, 0–100. Binary is right for technical work and wrong for
     * creative work, which is coming and grades on a rubric. Carrying the
     * column now is free; retrofitting a second grading system is not.
     */
    score: integer("score"),
    note: text("note"),
    createdAt,
  },
  (t) => [
    index("task_grades_task_idx").on(t.taskId),
    index("task_grades_grader_idx").on(t.graderUserId),
  ],
);

/**
 * Every state change, append-only.
 *
 * Same shape and same discipline as `job_events`: the application role holds
 * SELECT and INSERT and nothing else, so this is enforced by the database
 * rather than by everybody remembering.
 *
 * `actorId` is NULL for system actions — the sweep that expires a claim is
 * nobody's decision, and attributing it to whoever happened to trigger it
 * would be a lie in the one table that exists to be believed.
 */
export const taskEvents = pgTable(
  "task_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** NULL for system actions, such as a claim timing out. */
    actorId: uuid("actor_id").references(() => users.id),
    /** An address can change; the record of who acted must not. */
    actorEmailAtTime: text("actor_email_at_time"),
    action: text("action").notNull(),
    /** Field-level diff, not a whole-row dump. */
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt,
  },
  (t) => [index("task_events_task_idx").on(t.taskId)],
);

/* ------------------------------------------------------------------ */
/* The workspace: conversations with a model, scoped and receipted     */
/* ------------------------------------------------------------------ */
/*
 * See drizzle/0018_workspace_conversations.sql for the reasoning. In short:
 * every table below that holds conversation content is filtered by client AND
 * owner, children reference parents by (id, organization, owner) so a row
 * cannot attach itself to someone else's conversation, messages and receipts
 * are append-only, and `build` mode is refused by a constraint.
 */

export const conversationMode = pgEnum("conversation_mode", ["ask", "plan", "build"]);
export const messageRole = pgEnum("message_role", ["user", "assistant"]);
export const agentRunStatus = pgEnum("agent_run_status", [
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const receiptKind = pgEnum("receipt_kind", [
  "file",
  "folder",
  "job",
  "attachment",
  "tool_call",
  "warning",
]);
export const contextKind = pgEnum("context_kind", ["file", "folder", "job"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt,
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  mode: conversationMode("mode").notNull().default("ask"),
  engineMode: text("engine_mode").notNull(),
  /** 0019: the repository and branch this conversation is about. */
  repositoryId: uuid("repository_id"),
  branch: text("branch"),
  createdAt,
  updatedAt,
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const conversationMessages = pgTable("conversation_messages", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  role: messageRole("role").notNull(),
  content: text("content").notNull(),
  command: text("command"),
  runId: uuid("run_id"),
  status: text("status").notNull().default("complete"),
  createdAt,
});

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  userMessageId: uuid("user_message_id").notNull(),
  mode: conversationMode("mode").notNull(),
  engineMode: text("engine_mode").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  status: agentRunStatus("status").notNull().default("running"),
  error: text("error"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  /** 0019: which repository, branch and commit the run read. */
  repositoryId: uuid("repository_id"),
  branch: text("branch"),
  commitSha: text("commit_sha"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const agentRunReceipts = pgTable("agent_run_receipts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => agentRuns.id),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  kind: receiptKind("kind").notNull(),
  label: text("label").notNull(),
  ref: text("ref"),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  sentToProvider: boolean("sent_to_provider").notNull(),
  createdAt,
});

export const conversationContextItems = pgTable("conversation_context_items", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  kind: contextKind("kind").notNull(),
  ref: text("ref").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
});

export const engineModePolicies = pgTable("engine_mode_policies", {
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  engineMode: text("engine_mode").notNull(),
  allowed: boolean("allowed").notNull(),
  setBy: uuid("set_by")
    .notNull()
    .references(() => users.id),
  reason: text("reason"),
  createdAt,
});

/**
 * 0019: which client a GitHub repository belongs to. The link is the
 * authorisation — the GitHub App can see what it is installed on; a client may
 * see only what is linked to it. One live link per repository, across clients.
 */
export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  provider: text("provider").notNull().default("github"),
  installationId: bigint("installation_id", { mode: "number" }).notNull(),
  externalId: bigint("external_id", { mode: "number" }).notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").notNull(),
  linkedBy: uuid("linked_by")
    .notNull()
    .references(() => users.id),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
});
