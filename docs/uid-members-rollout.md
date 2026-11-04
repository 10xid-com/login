# Shared UiD Members — prepared for approval

This change replaces the demo invitation entry point with a business-scoped Members workspace. Owners and managers can invite and manage people within the existing role boundaries. Existing account holders receive invitations in their own UiD, accept them, and receive the business Channel. A business owner can grant Clothing Inventory access separately: none, view, edit, or edit and publish. The role names are the portal's existing six templates.

## Scope and authority

- Business memberships remain in `memberships`. Tool permissions use the existing tenant-isolated `permissions` table. Decisions are recorded in `audit_events`.
- The central endpoint binds the UiD service's host key to its current MFA sign-in and the verified account. Browser-provided email, host, and session fields cannot select an actor.
- Every inventory request rechecks membership and tool access. Editing does not confer publishing. Removing membership retires its tool grants; rejoining does not restore old grants.
- Owners retain owner-only management. A manager cannot appoint or edit an owner, nor grant inventory access beyond their own. The last owner cannot be removed or demoted.
- Closed business directories show ordinary members only their own membership. The full roster and invitations are available to the business's authorized managers.
- No access to personal Control Room state, passwords, or another business follows from an invitation.

## Prepared deployment changes

1. **Login service**, repository `10xid-com/login`, current feature branch `feature/uid-members-access`: deploy the Members API, central interface assets, and migration `0056_tbox_member_management`.
2. **Guarded owner setup**: the migration requires exactly one existing, live TBox membership held by the verified `paolo@tboxstudio.com` account. It changes only a legacy Staff/Member role to Owner, or does nothing if already Owner. A missing mapping or an unexpected modern role stops the migration. It neither creates accounts nor changes anyone else's membership. This is software authority; it is not a legal ownership record.
3. **Inventory connection**: on the login service, set `CLOTHING_API_URL` and `CLOTHING_API_KEY` using Railway references to the existing `control-room` values. Set `CLOTHING_BUSINESS_SLUG=tbox-studio`. The existing inventory data stays in its service.
4. **Paolo's UiD**, repository `10xid-com/10xid-id-preview`, branch `deploy/control-room-railway`: update its server adapter and inventory request URL support. It also serves the existing inventory code to the central service through a host-key-protected, asset-only endpoint.
5. **Ethan's and Rana's UiDs**, same repository, branch `main`: install the identical small adapter and HTML asset injection in `control-room-ethan` and `control-room-rana`. Their accounts and existing business memberships stay as they are.

The existing inventory source remains in its original private repository. The central login repository contains the new Members interface and proxies protected inventory assets; it does not copy the private inventory source into a public repository. Future UiD templates can install the adapter once and receive subsequent shared interface updates.

## Rollout and verification

Take or confirm a current recoverable database backup before applying the role migration. Deploy the UiD code with `UID_MEMBERS_ENABLED` unset or `false`: the protected inventory asset endpoint is available, while the existing screens and inventory route remain active. Deploy the central feature and its connection references, then verify the TBox owner mapping, private inventory connection, and host-key asset route. Set `UID_MEMBERS_ENABLED=true` on Paolo's UiD and verify it before enabling Ethan's and Rana's. This opt-in flag also provides a quick return to the previous UI and route while retaining the code release.

Verify the central deployment and all three UiD deployments reach SUCCESS. Check a real signed-in owner can load Members and the existing inventory, then use disposable test identities in an isolated test environment for invitation and access-changing acceptance checks. Do not invite real people or alter their roles merely to test the rollout.

## Validation performed in preparation

- TypeScript typecheck.
- Nineteen isolated access tests using PostgreSQL semantics under a restricted role, plus authentication and inventory proxy tests. The fixture data contains no production records.
- Four Node adapter checks covering actor binding, unavailable services, HTML injection, and protected asset access.
- Browser checks with sample accounts on Paolo, Ethan, and Rana templates: the dedicated screen loads and can open the shared inventory interface. Role/access save and invitation acceptance create the expected UI state. At 390 px frame width the Members content has no horizontal overflow.

Production acceptance and email delivery remain to be checked after approval and deployment. No production memberships or service configuration were changed during preparation.

## Recovery

Keep the previous service deployments and the pre-migration membership value. If the connection or new adapters fail, return the affected UiD deployment to its prior release; existing personal state is not migrated by this feature. The additive API can remain available while adapters are rolled back. A reversal of the TBox role setup must be a deliberate, audited change using the recorded prior role, rather than deletion of its history.
