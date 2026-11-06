# Verified sign-in links (10XiD pilot foundation)

A link ties two portal accounts (stable `users.id` + `auth_user_id`) so a person holding both can see **both sets of businesses** in My Businesses. It is **discovery only**: no role, permission or CiD access is ever derived from it. `scope()`, `uidMembers`, `uidChangeMember` and every write still authorize from the signed-in account's own membership rows. Roster responses never include alias or alternate-membership data.

## Proof (enforced in the database, migration 0062)
- Account A starts from a live session whose authenticator check is <=5 min old; gets a 10-char one-time code (only its SHA-256 is stored; 4 min expiry; one open challenge per account).
- Account B, from a **different account's own live, fresh session**, redeems it. Both sessions are re-read from `auth_sessions` inside `signin_link_complete`; the caller's word is not trusted.
- Single use, session-bound (A's session ending voids it), 5 misses/15 min lockout per redeemer, same-account / service / deleted / unsettled-binding refusals, max 5 active links per account, one active row per pair, links are never transitive.
- A link silently stops applying if either account's `auth_user_id` changes, or an account is deleted/service.
- Either side can revoke from a fresh session. `signin_link_audit` is append-only. The app role has no table access, only the four SECURITY DEFINER functions.

## Hardening (migration 0064)
- **Recipient binding.** A starts with the *verified address* of B. The recipient user, sign-in id and address are stored at issue; an unknown/unverified address returns the same "started" result but can never be redeemed (no enumeration). At redeem, the redeemer must still be that user, same sign-in id, and the address must still be verified. A wrong account holding the code only burns its own failure budget.
- **Both proofs enforced.** Completion requires the redeemer's TOTP <=5 min old and the initiator's proof (`initiator_proof_at`, bounded 5 min, same sign-in id, session still live).
- **Purpose-specific TOTP.** Each action verifies a fresh TOTP, then calls `signin_link_attest(session, purpose)` (needs `mfa_verified_at` <=60 s), which stores a single-use 2-minute attestation. The mutation consumes it and re-checks that `mfa_verified_at` did not move. An ordinary session id alone cannot start, redeem or revoke. After sign-in the user waits for the next TOTP step (the sign-in code cannot be reused).
- **Roles.** All link functions are EXECUTE for `portal_auth` only (reached via `authDb()`); `portal_app` has none. `signin_links_for` returns nothing unless the user has a live MFA session. SECURITY DEFINER functions pin `search_path = public, pg_temp`; consume/sweep/trigger are internal.
- **Concurrency.** Completion takes advisory locks on both users in sorted order, rechecks both caps and the pair uniqueness, and maps a unique violation (reverse duplicate) to `exists`.
- **Permanent revoke.** `signin_link_sweep` (also fired by a trigger on `users`) permanently revokes links when a sign-in id changes or an account is deleted/service. Restoring the data never revives the link; `signin_link_pair_history` still blocks the legacy fallback.

## Response shape (`/api/uid/business` `overview`)
`linkedMemberships[]` gains `source: "verified" | "legacy"`; new `signIn: {current:{id,email,primary}, alternates:[{id,email,name,primary,linkId}]}`. "Switch sign-in" = the PiD site sends the user through login with the alternate account.

## Legacy Rana pair
`lib/uid/legacy-rana-compat.ts` keeps the old behavior byte-for-byte (two ids, `uid-rana.10xid.com` only, display only, contact grouping) and is marked `source:"legacy"`. It is **not** seeded into `signin_links`. Remove it after both Rana accounts complete the flow below.

**No resurrection (migration 0063).** `signin_link_pair_history(a,b)` (SECURITY DEFINER, returns true if any link row, active or revoked, exists for the pair) makes `uidOverview` drop the legacy fallback for that pair once an explicit link has ever existed. After a revoke, neither account sees the other's businesses until a new verified link is made. The check fails closed (an error hides legacy display).

## Account page
`/auth/account` and `/auth/pid` render `SigninLinksPanel` (`app/auth/signin-links-panel.tsx`): steps, security assumptions, start / use-code / end-link forms and the active links with the partner's businesses (display only, from `verifiedDiscovery`). Every submit needs a fresh authenticator code. The one-time code is returned by the server action into client memory only, never a URL, redirect, storage or log. Switching accounts is deliberately not offered: the page says to sign in as the other account in its own browser profile, because signing out here would end the proving session.

**Verified address (migration 0065).** A start/redeem email counts as verified when exactly one live, non-service account claims it and that claim is proven by either a verified portal alias (`user_emails.verified_at`) or the exact `auth_users.email` with `email_verified=true`, joined to the account bound through `users.auth_user_id`. This covers Rana/Samay, whose alias was left unverified by 0047. Any second claimant (another account via alias, `users.email` or Better Auth) makes the match ambiguous and it fails. Redeem rechecks the identical condition (`signin_link_email_owner`). Both `users` rows are locked in canonical id order (`FOR UPDATE`) through the link insert, and proof and bindings are rechecked after the lock wait with `clock_timestamp()` (not the stale transaction `now()`).

## Deploy order
1. Deploy migrations 0062, 0063, 0064 and 0065 (0064 closes any open challenge) (additive, create no links, touch no tenant data). 2. Deploy app (older app ignores the new tables; the new app needs both first because `uidOverview` calls `signin_links_for` and `signin_link_pair_history`). 3. Optional: PiD site renders `signIn`/`source`.
Rollback: do not simply revert the app and leave the migrations. Once links exist, an app or schema older than 0065 (alias-only proof) no longer matches how links were proven, and reverting would strand or mis-show them. Before the first link is created take a pre-link database baseline and restore to it, or only roll back to an app version compatible with 0062-0065 (it must keep calling `signin_links_for` and `signin_link_pair_history`). Never drop the tables while links or audit rows exist.

## Not done / remaining
- Page is built but not exercised in a real browser with two real sessions (no live DB/auth in this workspace); covered by PGlite, mocked-action and server-render tests only.
- Real concurrency (parallel completes) is not exercised: PGlite is single-connection. Advisory locks are reviewed, not load-tested.
- A compromised `portal_auth` pool (the sign-in engine) is trusted by design.
- No in-page "switch account" button, by design (see above).
- Two simultaneous different-account sessions are required (two browsers/profiles); login UX is single-account per browser.
- No shared-mailbox flag exists in the schema; shared accounts rely on individual authenticator proof of both.
- Not run against real Postgres (PGlite only); 22 existing test files need a live DB and fail identically on base.
- Real Rana verification needs both owners to run the flow.
