# Public company identities and member editing

The five CiD hostnames remain anonymous public pages on the existing Cloudflare
Worker. `GET /api/profile` reads a fixed company-specific public projection from
`login.10xid.com/api/cid/<slug>`. No browser cookies or bearer credentials are
forwarded. The response contains only the explicitly published profile fields,
version, slug and connection status. The new public table holds no member,
customer, job, task or private contact data. No existing business data is published.

Manage CiD opens `/auth/cid/<slug>` on the existing login service. The editor
requires a current sign-in, MFA, a bound account and a live membership in that
exact company. Owner, Manager, Editor and Publisher roles can edit; other assigned
members need an explicit `cid.profile.write` capability. An explicit deny wins.
A grant without membership gives no access. Each save repeats authorization and
checks Origin, field lengths, URLs and the profile version. Membership changes
and saves use the same business lock. Postgres RLS independently restricts writes.
Changes publish immediately, persist in Railway and append an audit event.
Concurrent overwrites are rejected. Public pages do not import old browser drafts.

Only the public profile has a new editing workflow. Existing work features and
membership management retain their existing permission checks. Jobs, tasks and
member placeholders are hidden from the public CiDs; this release does not expose
or add editing APIs for those unfinished CiD integrations.

## Exact company mappings

| CiD slug | Existing organization slug |
|---|---|
| rotary | rotary-store |
| brandingcentres | branding-centres |
| vinylwraptoronto | vinyl-wrap-toronto |
| wrapauthority | wrap-authority |
| workweartoronto | workwear-toronto |

Rotary maps to the merchandise business, not the separate `rotary` club record.
Migration 0059 adds profiles populated only from verified public company websites to matching live organizations and
preserves their members, identities and private records. If Wrap Authority does
not exist under this slug or name, it can create that requested organization and
assign its existing verified TBox owner, Paolo, after checking his live TBox Owner
membership. Other missing mappings are reported and remain read-only; no fuzzy
matching, merging or reassignment occurs. Existing CiD/iD codes are not changed.

## Release

1. Review migration 0059's mappings and the conditional new Wrap Authority owner
   membership. Confirm a current database backup through the existing runbook.
2. Publish the login changes through its existing deployment branch, applying
   the additive migration through the existing migration command.
3. Verify all five `GET /api/cid/<slug>` responses report `connected: true`.
   Resolve a missing mapping explicitly before enabling editing for it.
4. Build `prototypes/company-id/build-worker.mjs` and update the existing
   `10xid-company-identities` Worker, preserving its custom domains and settings.
5. Check anonymous public views, signed-out editing redirects, an authorized
   save, a viewer/unrelated account denial and revoked membership denial.

No new environment secrets, authentication service or database is needed.
Rollback: return the Worker and login code to their previous releases. Leave the
additive profile table and audit history in place; never drop public edits to
roll back an interface change.

Validation uses isolated PGlite PostgreSQL semantics (including restricted-role
RLS), mocked session/action boundaries and Node Worker tests, without production
credentials or writes. End-to-end production login/save verification follows the
approved release, not these isolated tests.

The shared profile also stores six distinct allowlisted Action buttons. Swap and
0.7-second hold/right-click open the protected company editor. Choosing an
existing button swaps slots, matching PiD behaviour. Publishing saves the company
layout for all devices. Public contact links are clickable; the Location section
links to a verified Google Maps URL or a Google Maps search for the company and
its published address. Migration 0060 fills empty Rotary contact/location fields
from https://rotary.brandingcentres.com/contact, verified November 4, 2026:
Rotary@BrandingCentres.com, +1 416-288-8661, and 24 Ronson Drive, Unit 1,
Etobicoke, ON M9W 1B4, Canada, with its published Google Maps directions link.
No dedicated store social accounts were published there; those remain unset.
Existing editor-published values are preserved. No contact information is borrowed
from another company.

Migration 0060 also assigns the existing sign-in-linked Paolo TBox owner an Editor
membership in Workwear Toronto only. It preserves stronger existing roles and all
other memberships, honours an explicit editing denial, and audits the change.
Missing or ambiguous identity/mapping checks cannot grant access. The migration
is idempotent and tested against isolated PostgreSQL semantics.

Signed-in users without a linked account or company profile-editing permission
are redirected automatically from the editor URL to the matching public CiD.
Authorized editors keep the editor; operational failures remain visible for retry.

## Shared company Blog Posts

`/auth/cid/<slug>/blogs` serves Rana's existing blog editor as a company tool.
The login service requires a current session, MFA, a linked account and live
company editing permission for every document, asset and API request. Non-members
opening the workspace go directly to the public CiD. The server alone holds the
fixed Rana service credential; browser cookies and client credentials are never
forwarded. Mutations require the login origin.

The private Rana adapter maps each CiD to its fixed existing business stage.
It reuses the existing shared draft store, so previous Rana drafts remain
available without moving or copying content. Reads and tombstones are filtered by
company. Creates, ID overwrites and deletions enforce company scope inside the
same serialized state operation. The adapter excludes shop, quotes, member,
account-connection and arbitrary proxy routes.

Branding Centres, Vinyl Wrap Toronto and Workwear Toronto retain their existing
website publishing destinations. Rotary and Wrap Authority support shared drafts;
website publication stays disabled until a real connector is configured. Published
articles remain public on the connected company website; drafts are never added
to the anonymous CiD profile API. Existing social connections can supply embeds;
connection changes remain in the original service until their callback flow is
adapted to the company workspace.

Deploy the login routes and the Rana adapter from their existing repositories.
Rana's Post action opens the same company workspace; the protected CiD profile
editor also links to Blog Posts. No new database, volume or secret is required.
