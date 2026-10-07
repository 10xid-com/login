import "server-only";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  inAuthenticationTransaction,
  inTenantTransaction,
} from "./connection";
import {
  invitations,
  memberships,
  organizations,
  users,
  type MembershipRole,
} from "./schema";
import { isStaffMembership } from "@/lib/auth/policy";

/**
 * Invitations — how an account comes to exist.
 *
 * Accounts are not created by anybody typing an address into a form. A portal
 * holds several companies' data, and an address on its own says nothing about
 * which company its owner belongs to; letting a stranger decide that is the
 * whole tenancy model handed away at the front door.
 *
 * So somebody who already has access names the address and the company, and the
 * sign-up screen checks against that. An invitation on its own grants nothing:
 * until it is accepted there is no user row, no membership, and no session.
 */

export type InvitationRow = {
  id: string;
  email: string;
  role: MembershipRole;
  organizationId: string;
  organizationName: string;
  invitedByEmail: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

/**
 * Invitations last seven days and are used once (Revision 2). Long enough to
 * be acted on, short enough that a forgotten one is not a standing way in.
 */
export const INVITATION_TTL_DAYS = 7;

export async function inviteToOrganization(input: {
  organizationId: string;
  email: string;
  role: MembershipRole;
  invitedBy: string;
}): Promise<{ id: string }> {
  return inTenantTransaction(input.organizationId, false, async (tx) => {
    const email = input.email.trim().toLowerCase();

    // Re-inviting the same address replaces the outstanding invitation rather
    // than stacking a second one beside it, so withdrawing the visible one
    // cannot leave an invisible one still live.
    await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );

    const [row] = await tx
      .insert(invitations)
      .values({
        email,
        organizationId: input.organizationId,
        role: input.role,
        invitedBy: input.invitedBy,
        expiresAt: new Date(
          Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
        ),
      })
      .returning({ id: invitations.id });

    return { id: row.id };
  });
}

/**
 * The one lookup that happens before any scope exists.
 *
 * Someone signing up has no session and no company — this row is what produces
 * both — so it runs inside the narrow authentication exception rather than a
 * tenant transaction. It is SELECT-only there, and matches one exact address.
 */
export async function liveInvitationFor(emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();

  const rows = await inAuthenticationTransaction((tx) =>
    tx
      .select({
        id: invitations.id,
        organizationId: invitations.organizationId,
        role: invitations.role,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(invitations.createdAt))
      .limit(1),
  );

  return rows[0] ?? null;
}

/**
 * Turn an accepted invitation into an account, once.
 *
 * Everything happens in the invitation's OWN tenant scope — which is the point:
 * the company comes off the invitation row, never from anything the person
 * signing up typed. They choose their address; they do not choose their
 * company.
 *
 * The invitation is claimed by an atomic update requiring it to still be
 * unaccepted, so two simultaneous sign-ups produce exactly one account.
 */
export async function acceptInvitation(input: {
  invitationId: string;
  organizationId: string;
  email: string;
  role: MembershipRole;
  /**
   * The sign-in identity (Better Auth user) whose VERIFIED address is `email`.
   * The account is created already bound to it (users.auth_user_id).
   */
  authUserId?: string;
  /** 0021's WorkOS binding, superseded by authUserId and kept for its test. */
  workosUserId?: string;
}): Promise<{ userId: string } | null> {
  return inTenantTransaction(input.organizationId, false, async (tx) => {
    const claimed = await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(invitations.id, input.invitationId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning({ id: invitations.id });

    if (claimed.length !== 1) return null;

    /**
     * Staff-ness is not a field on the invitation form. It follows from the
     * SAME rule the session derives it by — isStaffMembership(), the one
     * function — so the flag stored on the account and the role the session
     * resolves to cannot be written from two different ideas of what staff is.
     *
     * It used to follow from the company alone: `org?.type === "internal"`.
     * That was the defect in the old session code seen from the other end, and
     * it minted the same wrong answer at the moment an account was created —
     * invite a bookkeeper into the house as a `member` and they arrived
     * flagged staff. Now it takes the invited ROLE as well, so an invitation
     * into a client company still cannot produce a staff account, and an
     * invitation into the house produces one only when it says `staff`.
     *
     * `type` is NOT NULL, so a missing company is the only way `org` is
     * undefined here; the optional chain then yields undefined, which is not
     * "internal", and a person invited to a company that has vanished mid
     * transaction is not staff. (The insert below would fail on the foreign
     * key anyway.)
     */
    const [org] = await tx
      .select({ type: organizations.type })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .limit(1);
    const isStaff = isStaffMembership({
      organizationType: org?.type ?? "client",
      role: input.role,
    });

    const [user] = await tx
      .insert(users)
      .values({
        email: input.email.trim().toLowerCase(),
        isStaff,
        isService: false,
        authUserId: input.authUserId ?? null,
        workosUserId: input.workosUserId ?? null,
      })
      .returning({ id: users.id });

    await tx.insert(memberships).values({
      userId: user.id,
      organizationId: input.organizationId,
      role: input.role,
    });

    return { userId: user.id };
  });
}

/** The invitations a session may see — their company's, or all while surveying. */
export async function listInvitations(scope: {
  isStaff: boolean;
  organizationId: string | null;
}): Promise<InvitationRow[]> {
  const surveying = scope.isStaff && scope.organizationId === null;

  return inTenantTransaction(scope.organizationId, surveying, (tx) =>
    tx
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        organizationId: invitations.organizationId,
        organizationName: organizations.name,
        invitedByEmail: sql<string | null>`(
          select u.email from users u where u.id = ${invitations.invitedBy}
        )`,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .innerJoin(
        organizations,
        eq(organizations.id, invitations.organizationId),
      )
      .where(and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
      .orderBy(desc(invitations.createdAt)),
  );
}

export async function revokeInvitation(
  organizationId: string,
  invitationId: string,
): Promise<void> {
  await inTenantTransaction(organizationId, false, (tx) =>
    tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(eq(invitations.id, invitationId)),
  );
}
