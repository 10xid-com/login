# Self-hosted sign-in (Better Auth) — architecture and cutover

Replaces the WorkOS integration that was drafted in `10xid-com/app` PR #2 and never went
live. No authentication provider, no subscription: Better Auth (MIT, `better-auth@1.7.7`)
runs inside the login service on Railway, on our Postgres, and sends its email through our
Resend account.

## Architecture

```
            login.10xid.com  (service "portal", repo 10xid-com/login)
            ┌──────────────────────────────────────────────────────────┐
 browser ──▶│ /auth/*  branded pages + server actions                   │
            │ /api/auth/*  Better Auth (password, emailed codes,        │
            │              Google, Microsoft) + mfa-gate plugin         │
            │ /auth/sso/authorize  mints a 30-second single-use ticket  │
            │ cookie: 10xid.session_token   host-only, HttpOnly, Lax    │
            └───────────────┬──────────────────────────────────────────┘
                            │ AUTH_DATABASE_URL (portal_auth)  ── auth_* tables
                            │ DATABASE_APP_URL  (portal_app)   ── users, invitations, tickets
                            ▼
                         Postgres (Railway)
                            ▲
                            │ DATABASE_APP_URL (portal_app) + 3 SECURITY DEFINER functions
            ┌───────────────┴──────────────────────────────────────────┐
 browser ──▶│ app.10xid.com  (service "app", repo 10xid-com/app)        │
            │ /auth/sso/start → login → /auth/sso/callback              │
            │ cookie: __Host-portal_session   host-only, HttpOnly, Lax  │
            │ every request: portal row live AND auth_session_touch()   │
            └──────────────────────────────────────────────────────────┘
```

Why the login host: sign-in stays in one place for every domain, the portal never handles a
password, an authenticator secret or a provider token, and the existing ticket handoff (already
built, tested and used in production for client domains) carries people across without any
cookie being shared between subdomains.

### What enforces what

| Rule | Where it is enforced |
|---|---|
| Authenticator after **every** method (password, emailed code, Google, Microsoft) | `lib/auth/mfa-gate.ts`: a session is born with `mfa_verified_at` NULL (0022 trigger forces it, whoever inserts the row); every Better Auth endpoint but finishing sign-in answers 403; the handoff refuses to mint a ticket; `auth_session_touch()` refuses an unverified session. Better Auth's own two-factor plugin is **not** installed: it gates only password sign-in, has a 30-day trust-device bypass, and can enable emailed codes as the "second" factor. |
| Verified enrolment, recovery codes | `/mfa/start-enrollment` (only from a session that proved the mailbox — an emailed code or a provider, never a password alone — and bound to that session, which alone can see the secret and confirm it) → `/mfa/confirm-enrollment` (needs a code from the app) → ten recovery codes, encrypted at rest, shown once. Codes: one use each per 30-second step, ever (replay), ten failures lock for 15 minutes, recovery codes consumed under a row lock. Regenerating codes or replacing the authenticator needs the authenticator within the last 10 minutes. Confirming a new authenticator, using a recovery code or replacing the authenticator ends every other session of the identity. Failures are counted under the factor's row lock, so parallel guesses cannot outrun the lockout. |
| 7-day hard maximum, 48 h idle | Postgres, not the app: 0022's trigger caps `expires_at` at `created_at + 7 days` on every write and keeps `created_at` immutable; row-level security hides from `portal_auth` any session past 7 days, past its expiry, or idle 48 h. The portal row gets the sign-in's hard end as its absolute expiry and 48 h idle, and checks the sign-in on every request. |
| Revocation, sign out everywhere | Login: account page (one session / all). Portal: Sign out (this browser's portal session **and** its sign-in) and Sign out everywhere (`auth_revoke_user_sessions`). Password reset revokes every session. Revoking a sign-in ends the portal session on its next request. |
| Invitation-only, no access from authentication alone | An identity is created only for an invited address or an existing account (`databaseHooks.user.create.before`), and only from a proven mailbox — an emailed code, or Google / Microsoft vouching for the address. There is no password sign-up: a password is added afterwards, from the account page, by somebody past the authenticator. Codes are emailed only to addresses that may sign in, without waiting on the mail (no timing tell). Access needs a portal account bound to the identity (`users.auth_user_id`): created by accepting an invitation made out to exactly the verified address, or set by an operator. The central authorization function in the app still decides every action per request. |
| No merging by email | `accountLinking.disableImplicitLinking`; an existing account with the same address gets an `identity_bindings` request that an operator confirms. `users.auth_user_id` is set once and only by an operator on an existing account (0022 trigger). Google is trusted for a verified address; Microsoft only with the `xms_edov` claim; otherwise a provider sign-in cannot create an identity. The first proof of an address deletes any password, provider link, authenticator and sessions attached before it (0022 trigger), so nobody can pre-register an invited address. |
| Database privilege boundaries | New role `portal_auth` (LOGIN, NOBYPASSRLS, owns nothing) holds the `auth_*` tables; `portal_app` is explicitly revoked from them and reaches sign-in sessions only through `auth_session_touch`, `auth_revoke_session`, `auth_revoke_user_sessions` (SECURITY DEFINER, fixed `search_path`). Both apps refuse to start if their role is privileged. |
| Rate limits | Better Auth's own limits cover `/api/auth/*` over HTTP. The pages' server actions call it in-process, which skips them, so every action that checks a secret or sends mail is counted first by client address and by the address or identity tried (`lib/auth/throttle.ts`, database-backed). Both key on `X-Real-IP` (Railway's edge); if Railway ever stopped setting it, everybody would share one bucket — check `CLIENT_IP_HEADER` if sign-ins are refused as "too many". |
| Redirects | `next` on the login host is only `/auth/sso/authorize?…` or `/auth/account`; the portal's return path never leaves the portal (state cookie); tickets are minted only for `PORTAL_HOST`. |
| CSRF / Origin | Login: Better Auth's origin check (explicitly on) + an exact-Origin check in every server action. Portal: exact Origin in the proxy and the authorization function + a CSRF token (HMAC keyed by the session cookie's secret). |
| `/healthz` | Both services, unauthenticated, answers `ok` and nothing else, on any host. |

## Residual risk

Better Auth always names its cookie `__Secure-…`; it cannot be given the stricter `__Host-`
prefix. A `__Secure-` cookie can still be set for `.10xid.com` by another `*.10xid.com` host, so a
compromised sibling host could plant a session of its own on the login host (login CSRF). Keep
every `*.10xid.com` host under our control; the portal's own cookie is `__Host-` and immune.

## Passwords and sessions that exist today

- **Passwords:** none exist (the current sign-in is emailed codes only), so nothing migrates.
  People sign in with an emailed code, Google or Microsoft, and may add a password afterwards.
- **Sessions:** current portal sessions are 400-day sessions and cannot carry the new
  guarantees. The new portal refuses every session without a sign-in behind it
  (`source_auth_session_id`), so **everybody signs in again once**.
- **Authenticators:** the old staff TOTP secrets are not migrated; everybody enrols an
  authenticator on first sign-in (it is now required for everyone).
- **Existing accounts:** the first sign-in with an address that already has an account creates
  a binding request and stops at "Waiting for confirmation". An operator confirms after checking
  with the person by another channel:

  ```bash
  npm run identity:bindings -- list
  npm run identity:bindings -- confirm <request id> --operator "Full Name"
  ```

  Lost phone and recovery codes: `npm run identity:bindings -- reset-authenticator <email> --operator "Full Name"`.

## Railway variables

### Service `portal` (login.10xid.com) — add

| Variable | Value |
|---|---|
| `BETTER_AUTH_SECRET` | 32+ random characters: `openssl rand -base64 48`. Encrypts authenticator secrets, recovery codes and OAuth tokens — **never rotate without a plan**. |
| `PORTAL_AUTH_PASSWORD` | A new random password for the `portal_auth` role (`openssl rand -hex 32`). The pre-deploy migration sets it. |
| `AUTH_DATABASE_URL` | The same form as `DATABASE_APP_URL`, with user `portal_auth` and `PORTAL_AUTH_PASSWORD`, e.g. `postgresql://portal_auth:${{PORTAL_AUTH_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional. Without them the Google button is hidden. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` | Optional (tenant defaults to `common`). Without them the Microsoft button is hidden. |
| `CLIENT_IP_HEADER` | Optional; default `x-real-ip` (Railway's edge). Rate limits key on it. |

Already present and still used: `DATABASE_URL`, `DATABASE_APP_URL`, `PRIMARY_HOST`,
`PORTAL_HOST`, `RESEND_API_KEY`, `MAIL_FROM`. Healthcheck path: set `/healthz` **after** the new
deployment is live (today's deployed code answers `/healthz` with 307).

### Service `app` (app.10xid.com) — add

| Variable | Value |
|---|---|
| `PORTAL_HOST` | `app.10xid.com` |
| `PRIMARY_HOST` | `login.10xid.com` |

Remove **after** the cutover is verified (nothing reads them; startup only warns):
`WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `NEXT_PUBLIC_WORKOS_REDIRECT_URI`,
`WORKOS_COOKIE_MAX_AGE`.

The `app` service's saved healthcheck path `/healthz` is correct for the new code but **not**
for the code deployed today (it answers 307): do not redeploy the current `main` with it set.

## Provider setup

**Google** (Google Cloud Console → APIs & Services → Credentials → OAuth client ID, type Web):
authorised redirect URI `https://login.10xid.com/api/auth/callback/google`; authorised
JavaScript origin `https://login.10xid.com`; scopes `openid email profile`. Publish the consent
screen (External) so it is not limited to test users.

**Microsoft** (Entra admin center → App registrations → New): supported account types as you
wish (multi-tenant + personal for `common`); redirect URI (Web)
`https://login.10xid.com/api/auth/callback/microsoft`; create a client secret (note its expiry);
**Token configuration → Add optional claim → ID → `xms_edov`** (without it Microsoft sign-ins
cannot create a new identity; they can still be linked from the account page after signing in
another way). API permissions: `openid`, `email`, `profile`, `offline_access`, `User.Read`.

**Resend:** the existing `RESEND_API_KEY` and verified sending domain are used for codes
(sign-in, address confirmation, password reset).

## Deployment order

Nothing here has been deployed. In order:

1. **Review and merge** the login PR (Better Auth + 0022) and app PR #2 (WorkOS removed,
   handoff restored). Merge does not deploy if the services are not set to auto-deploy; if
   they are, do steps 2–3 *before* merging.
2. **Login service variables**: add `BETTER_AUTH_SECRET`, `PORTAL_AUTH_PASSWORD`,
   `AUTH_DATABASE_URL` (and provider credentials if ready).
3. **App service variables**: add `PORTAL_HOST`, `PRIMARY_HOST`.
4. **Deploy login.** The pre-deploy step runs `scripts/migrate.mjs`: 0022 is additive (new
   role, new tables, new nullable columns, triggers, functions), then sets the role's password.
   Startup verifies `portal_auth` is restricted. Check `https://login.10xid.com/healthz` → 200,
   then sign in once yourself (enrol an authenticator) and confirm your own binding with the
   operator script. Old portal sessions keep working against the old app until step 5.
5. **Deploy app.** Every existing portal session is refused; people are sent to the new
   sign-in once. Check `https://app.10xid.com/healthz` → 200, sign in end to end, sign out.
6. Set the login service's healthcheck path to `/healthz`.
7. Remove the four `WORKOS_*` variables from `app` (startup lists them while present), and `TOTP_ENC_KEY` from `portal`.

## Rollback

- **App:** redeploy the previous deployment from Railway's history. Note its healthcheck: the
  previous code answers `/healthz` with 307, so clear the healthcheck path first or the
  rollback deployment will fail its check. The previous code ignores the new columns.
- **Login:** redeploy the previous deployment. 0022 needs no rollback: it is additive, the old
  code never touches `auth_*`, `portal_auth` or the new columns, and the nullable
  `sso_tickets.source_session_id` still accepts the old code's inserts. To retire it later,
  `REVOKE LOGIN` on `portal_auth` stops the new engine without dropping data.
- Roll back **app before login** if both are needed, so the portal never points at a login
  host that cannot mint its tickets.

## The old sign-in

The previous emailed-code sign-in (`/auth/login`, `/auth/signup`, `/auth/verify`, `/auth/2fa`,
`/auth/recovery-codes`) and its code and tests are removed. Its tables (`sign_in_codes`,
`users.totp_secret`, `recovery_codes`) stay, untouched, because migrations here are additive;
old links to those paths now find nothing, and the handoff sends everybody to `/auth/sign-in`.
`TOTP_ENC_KEY` is no longer read and can be removed from the login service after the cutover.
