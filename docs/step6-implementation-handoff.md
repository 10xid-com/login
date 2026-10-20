# Step 6 implementation and staging handoff

Status: implemented in development branches; **not deployed or accepted**.
Date: October 20, 2026.

## Implemented behavior

- Linking begins from an authenticated, live Wrap Authority Supabase session.
- A signed five-minute state cookie binds the request to that exact WA user and session. A database request record makes completion one-time.
- 10XiD displays an explicit consent page. Its POST verifies the signed session-bound challenge, exact Origin, registered client/callback and MFA within five minutes. A stale session must verify a new authenticator code.
- 10XiD's existing ticket store provides short-lived, audience-bound, atomic code redemption, with a live source-session check.
- The WA callback only stages the result. The library proves the same live WA bearer session before an atomic database operation creates the account link.
- Unlinking revokes the association and invalidates all outstanding requests under the same per-user transaction lock.
- The 10XiD portal page at /wrapauthority reads metadata from WA through a 30-second, audience/issuer/scope-bound server assertion. WA checks the live portal session with its owner on every request.
- WA remains the purchase authority. Its SQL matches external principal → active WA link → WA customer → non-revoked entitlement → same-tenant product. Disabled WA users are refused.
- Artwork is not copied to the portal. Downloads stay in WA, enforce a live JWT-bound buyer session, use the existing entitlement/RLS check, and verify exact private B2 bytes against size and SHA-256.
- Exposed database functions are SECURITY INVOKER. The minimal auth-session readers live in the unexposed step6_private schema. The buyer helper can inspect only auth.uid() and its signed session_id, never arbitrary identities.

## Configuration

Integration routes are disabled unless WA_INTEGRATION_ENV is explicitly set. No deployment flags, production authentication settings, DNS or payment settings were changed.

For isolated staging, set these same three **exact**, distinct HTTPS origins on WA, login and portal:
- WA_INTEGRATION_ENV=staging
- WA_STAGING_ORIGIN=https://staging-... (the WA service)
- WA_STAGING_LOGIN_ORIGIN=https://staging-... (the login service)
- WA_STAGING_PORTAL_ORIGIN=https://staging-... (the portal service)

Hostnames must start with staging-, staging., stage-, preview- or test- (the corresponding dotted forms also work). No credentials, non-default ports, paths, queries, wildcards or request-derived origins are accepted. WA staging is pinned to the already approved Supabase branch ehejnxhznfnxoetnnhxg; it refuses the production database reference.

Secrets and client IDs must be generated/configured through the approved secret manager, never committed:
| WA setting | Matching service setting | Purpose |
|---|---|---|
| WA_10XID_CLIENT_ID | Login: WA_EXTERNAL_CLIENT_ID | Exact registered client ID |
| WA_10XID_CLIENT_SECRET | Login: WA_EXTERNAL_CLIENT_SECRET | Confidential single-use code redemption |
| WA_10XID_LINK_SECRET | WA only | Signed initiating/completion cookies |
| WA_PORTAL_ASSERTION_SECRET | Portal: WA_PORTAL_ASSERTION_SECRET | Scoped server-only purchase assertions |

Each secret needs at least 32 characters of independent cryptographic randomness. Do not reuse them. Only WA receives its dedicated Supabase service-role key. Portal and login must use their existing restricted database roles against a separately migrated, empty staging identity database; never clone production identities or authenticators into staging.

Production mode uses only the fixed existing WA/login/portal origins. It remains an explicit later release decision, after staging acceptance.

## Database source and deployment order

1. Reconcile the existing partial Supabase branch using supabase/step6/staging-repair.sql through the approved migration path. It is a transaction and refuses populated or already-complete targets. It restores missing historical grants, constraints, private membership helper, checkout_orders ledger and verified-download RPC. The legacy unverified-download RPC is not recreated. Fulfillment runs as SECURITY INVOKER with service-only execute access.
2. Apply supabase/step6/identity-purchase-functions.sql to isolated staging. This contains session checks, one-time requests, atomic completion/unlink and the scoped purchase projection. No live-sale flags are enabled.
3. Run security advisors and the role/authorization tests on the actual branch.
4. Deploy WA, login and portal development branches into isolated services, with the exact staging origins and distinct staging secrets. Observe terminal deployment success.
5. Complete browser acceptance using two disposable buyers, an independent browser/device and a synthetic owned artwork fixture. Verify expired delivery recovery, wrong-buyer denial, revocation, linking and the same authoritative asset/checksum.

The SQL files are reviewed source bundles, not invented Supabase migration-history entries. Use the migration workflow to package them; do not mark rejected migrations as applied or change production. Earlier service safety rejections are not bypassed by these files.

The existing checkout ledger is named platform.checkout_orders, **not checkout_sessions**. Earlier notes used the wrong table name.

## Verification

Local verification uses Node 24:
- WA: npm run test:step6 — 31 passing checks including the reconstructed partial staging schema, actual PostgreSQL role/RLS checks, linking/replay/revocation and route/storage doubles.
- WA: recovery regression — 12 pass; tax regression — 9 pass.
- Login: selected consent/MFA, client/callback, page inventory and SSO URL suites — 24 pass.
- Portal: selected authorization, page inventory, assertion protocol and actual session-query suites — 227 pass.
- TypeScript checks pass for both complete 10XiD source trees and all changed WA files.
- ESLint passes for changed login and portal logic.

The local PostgreSQL engine is disposable PGlite, with captured schema source and synthetic identities. Provider doubles are used for HTTP/storage tests. Selected Vitest units use inert local connection URLs solely for their global setup; they do not certify the pre-existing full database suite. Remote CI and browser tests against the real staged services remain required.

Do not count this record as Step 6 acceptance or permission to merge/release. No production changes or live payment activation occurred.
