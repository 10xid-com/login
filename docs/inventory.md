# Inventory (migration 0048)

What a business owns, what each thing is, where it came from, what is left of
it, and what to order before a dated batch. The schema lives here, like every
other table; the screens live in `10xid-com/app`. This document is the why;
`drizzle/0048_inventory.sql` is the how, and `test/inventory.test.ts` is the
proof.

## Rules the database enforces

1. **One business's inventory is its own.** Every table but `inventory_units`
   carries `organization_id` and the tenant policy of 0001: an unscoped
   connection sees nothing, and a row can only be written into the business in
   scope. There is no staff read policy. `scripts/check-rls.ts` lists all 35
   tables as protected.
2. **Rows only point at rows of the same business.** Each parent has
   `UNIQUE (organization_id, id)` and each child references that pair, so a
   guessed uuid from another business is refused by the foreign key, not merely
   hidden.
3. **Vendors, suppliers and manufacturers are companies with their own iD.**
   See below.
4. **Stock is a ledger**, append-only for the application. Balances are derived;
   unknown is never zero.
5. **A formulation version freezes when it leaves draft**, and a batch is only
   recorded from a frozen version.
6. **A purchase is approved by a person of the business.** An agent (a service
   account) may propose, and may move an approved purchase into a cart. Every
   change of state is written to `audit_events`.

## Companies and their iDs

A company is a row in `organizations`, one per real company however many roles
it plays. Type `listed` marks one that 10XiD knows about but that has not
claimed an account.

| Question | Answer |
| --- | --- |
| Where is a company's iD? | In `identities`, the same register as people's iDs. A row is held by a person (`user_id`) **or** a company (`organization_id`), never both (`identities_exactly_one_holder`). |
| Namespace and uniqueness | One namespace for people and companies: `id_code` is unique forever, revoked rows included, so a code is never handed to anyone else. At most one live iD per holder. |
| Format | `10X-` and five Crockford base32 characters (no I, L, O, U), from `next_id_code()`, following the example in the identities documentation. |
| Issue | `list_company(name)` creates a `listed` company and issues its iD in one call; `issue_company_id(company)` issues one to an existing listed company and returns the live code if it already has one. Both run with the caller's rights. |
| Who may issue | The application, to `listed` companies only. A client's or the house's iD is an operator's decision (`identities_company_rules`). |
| Revoke / reissue | Operator only: `reissue_company_id(company)` stamps the live iD revoked and issues a new code. The application role cannot change a company's iD. |
| What links to it | Nothing references the code. Inventory links to `inventory_businesses.id`, which points at `organizations.id`. Reissuing a code moves no purchase, offer or container. `inventory_orders.vendor_code` keeps the code as it was, as paperwork. |
| Access it grants | None. A listed company cannot be given members or invitations (`listed_companies_have_no_members`), has no sign-in, and is not in scope for any inventory row. |
| Who can see it | `identities` is exempt from row-level security (reason in `scripts/check-rls.ts`): an iD is looked up by its public code before any scope exists, and a vendor's iD is shared by all its customers. Each business's relationship with the company — roles, account number, notes, preferences, orders and photos — is in tenant-protected tables. |

`inventory_businesses` is that private relationship: one row per company per
business, with `is_vendor`, `is_supplier`, `is_manufacturer` and
`is_brand_owner`. A brand (`inventory_brands`) is a name with an optional owner;
a product names its brand, its manufacturer and its distributor separately.

## Table map

| Area | Tables |
| --- | --- |
| Reference | `inventory_units` (shared; mass, volume, count, energy, and unconvertible units such as drops and IU) |
| What things are | `inventory_nutrients`, `inventory_materials` (name + specification), `inventory_material_aliases`, `inventory_products` (variant, form, package, GTIN, composition state), `inventory_product_components` (amount optional), `inventory_product_nutrients`, `inventory_product_claims` |
| Companies | `organizations` + `identities` (shared), `inventory_businesses`, `inventory_brands` |
| Buying | `inventory_offers` (dated price and stock status, lead time and its basis), `inventory_offer_prices`, `inventory_sourcing_preferences` (rank 1 preferred, then alternatives), `inventory_orders`, `inventory_order_lines`, `inventory_receipts`, `inventory_receipt_lines` |
| Physical stock | `inventory_locations`, `inventory_lots` (printed and parsed dates, acquisition date, hold), `inventory_containers` (label contents kept apart from what is left), `inventory_measurements` (gross, tare, net) |
| Capture | `inventory_captures` (one sitting, confirmed once), `inventory_documents` (private store key, content hash, upload state), `inventory_document_links`, `inventory_extractions` (named engine), `inventory_extracted_fields` (raw text, locator, confidence, review), `inventory_match_candidates` |
| Ledger | `inventory_movements` |
| Planning and production | `inventory_formulations`, `inventory_formulation_versions`, `inventory_formulation_lines` (batch, required addition, optional addition), `inventory_batch_plans`, `inventory_reservations`, `inventory_batches` |
| Notes and purchasing | `inventory_notes`, `inventory_purchase_intents` |
| Views (caller's rights) | `inventory_business_directory`, `inventory_container_balances`, `inventory_order_line_status`, `inventory_plan_requirements`, `inventory_purchase_options` |

## The ledger

Anchor events state what a container holds: `opening` (first catalogued),
`receipt`, `fill`, `production_output`, `count`. Change events add or remove:
`production_use`, `adjustment`, `loss`, `disposal`, `transfer_in`,
`transfer_out`, `return`. A `reversal` voids one earlier event and needs a
reason.

A balance is the latest anchor plus the changes after it. An `opening` whose
amount is unknown (`basis = 'unknown'`, no quantity) keeps the balance unknown
until something is counted. Each amount carries its basis: `labelled_unopened`
(only for a sealed container), `measured` (an anchor must link the weighing, and
must equal its net), `estimated`, or `calculated`. A container is opened once and
received once, whatever the retries; idempotency keys make a retried request
find its first attempt.

A weighing stores gross, tare and net. With both gross and tare, net is their
difference. Without a tare, net is unknown, or an explicit estimate below the
gross; the gross is never taken as the contents.

## Replenishment

`inventory_plan_requirements` gives, per open plan and material, the amount
required, what the plan has reserved, usable stock, what is arriving in time,
and the shortfall. Plans are taken in date order and each is counted once; a
plan with a recorded batch drops out. Usable stock is sealed or open, not on
hold, of known amount, not expired by the plan's date, and of a product whose
composition states the material's amount. Containers of unknown amount are
reported as `containers_to_verify`. Orders count only for what is outstanding
and expected on or before the plan's date.

`inventory_purchase_options` turns each shortfall into whole packages of each
ranked offer, with the amount bought, the excess, and the dated price and stock
status. It recommends the best-ranked offer showing stock; an offer whose stock
was never checked is listed but never recommended.

## Deployment and recovery

The migration is one file, applied by `scripts/migrate.mjs` on the `portal`
deploy. The migrator applies all pending files in **one transaction**: if
anything in 0048 fails, nothing from it remains, the pre-deploy step fails, and
the running release keeps serving.

Changes to existing objects, all additive:

- `organization_type` gains `listed`. Postgres cannot remove an enum value; an
  unused one is harmless.
- `identities` gains nullable `organization_id`, loses `NOT NULL` on `user_id`
  (replaced by the exactly-one-holder check), and gains a partial unique index
  and a trigger. Existing people's iDs are untouched.
- `memberships` and `invitations` gain a trigger refusing rows for listed
  companies. Existing rows are untouched; no other company type is affected.

Before applying to the live database, take the logical dump described in
`docs/recoverability-runbook.md` (Railway has no point-in-time recovery on the
current plan).

If 0048 must be withdrawn after it has applied, prefer a forward fix. A
withdrawal that touches nothing else, run as the owner, is:

```sql
BEGIN;
DROP VIEW IF EXISTS inventory_purchase_options, inventory_plan_requirements,
  inventory_order_line_status, inventory_container_balances, inventory_business_directory;
DROP TABLE IF EXISTS inventory_purchase_intents, inventory_notes, inventory_movements,
  inventory_batches, inventory_reservations, inventory_batch_plans, inventory_formulation_lines,
  inventory_formulation_versions, inventory_offer_prices, inventory_product_claims,
  inventory_product_nutrients, inventory_measurements, inventory_match_candidates,
  inventory_extracted_fields, inventory_extractions, inventory_document_links, inventory_documents,
  inventory_captures, inventory_containers, inventory_lots, inventory_locations,
  inventory_receipt_lines, inventory_receipts, inventory_order_lines, inventory_orders,
  inventory_sourcing_preferences, inventory_offers, inventory_product_components, inventory_products,
  inventory_formulations, inventory_brands, inventory_businesses, inventory_material_aliases,
  inventory_materials, inventory_nutrients, inventory_units;
DROP TRIGGER IF EXISTS memberships_not_for_listed_companies ON memberships;
DROP TRIGGER IF EXISTS invitations_not_for_listed_companies ON invitations;
DROP TRIGGER IF EXISTS identities_company_rules ON identities;
DROP FUNCTION IF EXISTS list_company(text), issue_company_id(uuid), reissue_company_id(uuid),
  next_id_code(), identities_company_rules(), listed_companies_have_no_members(),
  inventory_movements_rules(), inventory_batches_rules(), inventory_formulation_lines_rules(),
  inventory_formulation_versions_rules(), inventory_captures_rules(), inventory_orders_vendor_code(),
  inventory_purchase_intents_rules(), inventory_sourcing_preferences_rules();
-- Only if no company holds an iD (otherwise keep the column: those iDs are facts):
--   ALTER TABLE identities DROP CONSTRAINT identities_exactly_one_holder;
--   DROP INDEX identities_one_live_per_organization;
--   ALTER TABLE identities DROP COLUMN organization_id;
--   ALTER TABLE identities ALTER COLUMN user_id SET NOT NULL;
DELETE FROM drizzle.__drizzle_migrations
 WHERE hash = '<sha256 of drizzle/0048_inventory.sql as deployed>';
COMMIT;
```

Inventory photos are objects under `inventory/<organization id>/` in the private
media bucket; withdrawing the schema does not delete them.

## Status

| Layer | State |
| --- | --- |
| Schema, views, functions, triggers | In this migration. |
| Tests | `test/inventory.test.ts`: migration re-runnable, policies and views, and acceptance scenarios A02–A12 at the database level, under the restricted role. |
| Screens (capture, review, inventory list) | `10xid-com/app`, after this schema is copied there. |
| Live database | Not applied until review and approval. |
