# Verified sign-in links (10XiD pilot foundation)

A link ties two portal accounts (stable `users.id` + `auth_user_id`) so a person holding both can see **both sets of businesses** in My Businesses. It is **discovery only**: no role, permission or CiD access is ever derived from it. `scope()`, `uidMembers`, `uidChangeMember` and every write still authorize from the signed-in account's own membership rows. Roster responses never include alias or alternate-membership data.

## Proof (enforced in the database, migration 0062)
- Account A starts from a live session whose authenticator check is <=5 min old; gets a 10-char one-time code (only its SHA-256 is stored; 10 min expiry; one open challenge per account).
- Account B, from a **different account's own live, fresh session**, redeems it. Both sessions are re-read from `auth_sessions` inside `signin_link_complete`; the caller's word is not trusted.
- Single use, session-bound (A's session ending voids it), 5 misses/15 min lockout per redeemer, same-account / service / deleted / unsettled-binding refusals, max 5 active links per account, one active row per pair, links are never transitive.
- A link silently stops applying if either account's `auth_user_id` changes, or an account is deleted/service.
- Either side can revoke from a fresh session. `signin_link_audit` is append-only. The app role has no table access, only the four SECURITY DEFINER functions.

## Response shape (`/api/uid/business` `overview`)
`linkedMemberships[]` gains `source: "verified" | "legacy"`; new `signIn: {current:{id,email,primary}, alternates:[{id,email,name,primary,linkId}]}`. "Switch sign-in" = the PiD site sends the user through login with the alternate account.

## Legacy Rana pair
`lib/uid/legacy-rana-compat.ts` keeps the old behavior byte-for-byte (two ids, `uid-rana.10xid.com` only, display only, contact grouping) and is marked `source:"legacy"`. It is **not** seeded into `signin_links`. Remove it after both Rana accounts complete the flow below.

## Deploy order
1. Deploy migration 0062 (additive, creates no links, touches no tenant data). 2. Deploy app (older app ignores the new tables; the new app needs 0062 first because `uidOverview` calls `signin_links_for`). 3. Optional: PiD site renders `signIn`/`source`.
Rollback: revert app; migration can stay.

## Not done / remaining
- **No page yet.** `app/auth/signin-link-actions.ts` (start/complete/revoke, TOTP re-confirm each time, throttle `signinLink`) is unwired; a `/auth/account` section is needed. The code is returned to the caller, not placed in a URL.
- Two simultaneous different-account sessions are required (two browsers/profiles); login UX is single-account per browser.
- No shared-mailbox flag exists in the schema; shared accounts rely on individual authenticator proof of both.
- Not run against real Postgres (PGlite only); 22 existing test files need a live DB and fail identically on base.
- Real Rana verification needs both owners to run the flow.
