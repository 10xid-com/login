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

**No resurrection (migration 0063).** `signin_link_pair_history(a,b)` (SECURITY DEFINER, returns true if any link row, active or revoked, exists for the pair) makes `uidOverview` drop the legacy fallback for that pair once an explicit link has ever existed. After a revoke, neither account sees the other's businesses until a new verified link is made. The check fails closed (an error hides legacy display).

## Account page
`/auth/account` and `/auth/pid` render `SigninLinksPanel` (`app/auth/signin-links-panel.tsx`): steps, security assumptions, start / use-code / end-link forms and the active links with the partner's businesses (display only, from `verifiedDiscovery`). Every submit needs a fresh authenticator code. The one-time code is returned by the server action into client memory only, never a URL, redirect, storage or log. Switching accounts is deliberately not offered: the page says to sign in as the other account in its own browser profile, because signing out here would end the proving session.

## Deploy order
1. Deploy migrations 0062 and 0063 (additive, create no links, touch no tenant data). 2. Deploy app (older app ignores the new tables; the new app needs both first because `uidOverview` calls `signin_links_for` and `signin_link_pair_history`). 3. Optional: PiD site renders `signIn`/`source`.
Rollback: revert app; migration can stay.

## Not done / remaining
- Page is built but not exercised in a real browser with two real sessions (no live DB/auth in this workspace); covered by PGlite, mocked-action and server-render tests only.
- No in-page "switch account" button, by design (see above).
- Two simultaneous different-account sessions are required (two browsers/profiles); login UX is single-account per browser.
- No shared-mailbox flag exists in the schema; shared accounts rely on individual authenticator proof of both.
- Not run against real Postgres (PGlite only); 22 existing test files need a live DB and fail identically on base.
- Real Rana verification needs both owners to run the flow.
