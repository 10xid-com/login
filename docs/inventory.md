# Inventory (migrations 0048 and 0049)

What a business owns, what each thing is, where it came from, what is left of
it, and what to order before a dated batch. The schema lives here, like every
other table; the screens live in `10xid-com/app`. This document is the why;
`drizzle/0048_inventory.sql` and `drizzle/0049_container_acquisitions.sql` are
the how, and `test/inventory.test.ts` and `test/inventory-acquisitions.test.ts`
are the proof.

## Rules the database enforces

1. **One business's inventory is its own.** Every table but `inventory_units`
   carries `organization_id` and the tenant policy of 0001: an unscoped
   connection sees nothing, and a row can only be written into the business in
   scope. There is no staff read policy. `scripts/check-rls.ts` lists all 36
   tables as protected.
2. **Rows only point at rows of the same business.** Each parent has
   `UNIQUE (organization_id, id)` and each child references that pair, so a
   guessed uuid from another business is refused by the foreign key, not merely
   hidden.
3. **Vendors, suppliers and manufacturers are companies with their own iD.**
   See below.
4. **Stock is a ledger**, append-only for the application, and so are the
   weighings it rests on. Balances are derived; unknown is never zero; an
   amount is `measured` only on exact scale evidence.
5. **A formulation version freezes when it leaves draft**, and a batch is only
   recorded from a frozen version.
6. **A purchase is approved by the person approving it**, a member of the
   business who is not a service account, never in someone else's name. An
   agent may propose, revise a proposal, and move an approved purchase into a
   cart; the approved terms cannot change afterwards. Every change of state,
   and every revision of a proposal, is written to `audit_events`.
7. **Reservations are only as good as the stock behind them**, checked when
   made and again at every read of the requirements.
8. **How a container was bought is recorded per container, as known, and
   kept** (0049): seller, date, price and paperwork, each optional; a
   correction is a new record, never an edit; recording it never adds stock.

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
| Buying | `inventory_offers` (dated price and stock status, lead time and its basis), `inventory_offer_prices`, `inventory_sourcing_preferences` (rank 1 preferred, then alternatives), `inventory_orders`, `inventory_order_lines`, `inventory_receipts`, `inventory_receipt_lines`, `inventory_container_acquisitions` (0049: how one container was bought, with its corrections) |
| Physical stock | `inventory_locations`, `inventory_lots` (printed and parsed dates, acquisition date, hold), `inventory_containers` (label contents kept apart from what is left), `inventory_measurements` (gross, tare, net) |
| Capture | `inventory_captures` (one sitting, confirmed once), `inventory_documents` (private store key, content hash, upload state), `inventory_document_links`, `inventory_extractions` (named engine), `inventory_extracted_fields` (raw text, locator, confidence, review), `inventory_match_candidates` |
| Ledger | `inventory_movements` |
| Planning and production | `inventory_formulations`, `inventory_formulation_versions`, `inventory_formulation_lines` (batch, required addition, optional addition), `inventory_batch_plans`, `inventory_reservations`, `inventory_batches` |
| Notes and purchasing | `inventory_notes`, `inventory_purchase_intents` |
| Views (caller's rights) | `inventory_business_directory`, `inventory_container_balances`, `inventory_order_line_status`, `inventory_plan_requirements`, `inventory_purchase_options` |

## Capture and evidence

A capture is one sitting in front of one container. Its photos are the
documents linked to it (`inventory_document_links.capture_id`). A document is
one FILE per business (unique content hash), not one jar: the same label photo
can be linked to several captures and, once they are confirmed, to several
containers — two identical jars photographed once are two containers, each
with its own opening event. Every link is made once (`UNIQUE NULLS NOT
DISTINCT`), so retried uploads and confirmations find their link. At most one
capture creates a container (`outcome = 'new_container'`); later captures of
the same jar confirm it as an existing one.

## The ledger

Anchor events state what a container holds: `opening` (first catalogued),
`receipt`, `fill`, `production_output`, `count`. Change events add or remove:
`production_use`, `adjustment`, `loss`, `disposal`, `transfer_in`,
`transfer_out`, `return`. A `reversal` voids one earlier event and needs a
reason.

A balance is the latest anchor plus the changes after it. An `opening` whose
amount is unknown (`basis = 'unknown'`, no quantity) keeps the balance unknown
until something is counted. Each amount carries its basis:

| Basis | Only when |
| --- | --- |
| `labelled_unopened` | The container is sealed, and the amount is its nominal contents (in any unit of the same kind: 0.5 kg = 500 g). |
| `measured` | An anchor links a weighing of this container that is on a `scale`, `exact`, with any tare weighed too (`tare_basis = 'measured'`); the container is counted by mass; the amount equals the weighing's net. A change event citing a weighing needs the same quality. A visual or rough figure, a label reading, an estimated tare, or millilitres and items are never `measured`. |
| `estimated` | Anything else known approximately, with or without a weighing behind it. |
| `calculated` | Derived (production). |

A container is opened once and received once, whatever the retries; idempotency
keys make a retried request find its first attempt.

A weighing stores gross, tare and net. With both gross and tare, net is their
difference. Without a tare, net is unknown, or an explicit estimate below the
gross; the gross is never taken as the contents. Weighings are insert-only for
the portal, and once a stock event rests on one nobody can change or remove it
(`inventory_measurements_rules`): a correction is a new weighing and a new
`count`.

## Replenishment

`inventory_plan_requirements` gives, per open plan and material, the amount
required, its reservations, usable stock, what is arriving in time, what the
plan is allocated, and the shortfall. It is computed by
`inventory_plan_requirements_rows()`, with the caller's rights, the way the
stock would really be used:

1. **Demand**: every open plan (no batch recorded yet), each counted once. A
   recipe line must be in a fixed-size unit of its material's kind (refused
   otherwise); if one still cannot be counted, the requirement and shortfall
   are NULL — unknown, never smaller.
2. **Supply**: containers that are sealed or open, not on hold, of known
   amount, of a product whose composition states the material's amount, each
   usable up to its expiry date; and outstanding order quantities, usable from
   their expected date (undated orders do not count). Containers of unknown
   amount are `containers_to_verify`.
3. **Reservations first**, earliest made first: each counts only for what its
   container can still give that plan on the plan's date (still supply, not
   expired by then, not already given to an earlier reservation, in a unit of
   the material's kind). The rest is `reserved_unbacked`, counted in
   `reservations_to_review`, and the plan shows short. A reservation is also
   refused when it is made if it could not be honoured then
   (`inventory_reservations_rules`, which locks the container while it checks).
4. **Then each plan in date order** (same date: the order plans were made)
   takes what it still needs from what is left and usable on its date,
   earliest-expiring first, shelf before deliveries. Stock expiring between
   two plans goes to the earlier plan instead of being counted against the
   later one; a delivery helps only plans on or after its expected day.

A plan's date is its planned date, or today if it is overdue. One known
simplification: a product holding several materials supplies each in full,
independently.

`inventory_purchase_options` turns each shortfall into whole packages of each
ranked offer, with the amount bought, the excess, and the dated price and stock
status. It recommends the best-ranked offer showing stock; an offer whose stock
was never checked is listed but never recommended.

## Purchases of a container (0049)

`inventory_container_acquisitions` records how ONE container was acquired:
who sold it (`vendor_id`, an `inventory_businesses` row, so a company with its
own iD), when (`acquired_on`), for how much (`price` with `currency`), the
paperwork (`document_id`), and optionally the order line it was bought on.

- **Per container, never per lot or product.** A lot is shared by every
  container of one product, lot code and date, so two jars of one lot bought
  from two sellers at two prices would be misattributed on the lot
  (`inventory_lots.receipt_line_id` stays a receiving fact). Recording a
  purchase changes no lot, product or other container.
- **Everything is optional, nothing is invented.** No "unknown vendor", no
  default currency, no zero price: an unknown fact is NULL. The first record
  of a container must say something (`..._says_something`).
- **Price** is the price of this one package as recorded, in its currency
  (three capital letters): a finite number, never negative (numeric `NaN` is
  refused explicitly, since PostgreSQL sorts it above every number), never
  without its currency and no currency without a price. Zero is stored only
  when it was entered. No shipping or tax is shared out here.
- **Corrections are new records.** A record is a full snapshot of what is
  known. A correction supersedes the record it corrects (`supersedes_id`), of
  the same container, and may clear a fact back to unknown. One first record
  per container and each record superseded at most once make one linear
  chain; the **current** record is the one nothing supersedes. Records are
  kept as written: the application may only SELECT and INSERT, and
  `inventory_container_acquisitions_kept` refuses UPDATE and DELETE even for
  the owner. Nothing a record cites — container, seller, order line, document
  — can be deleted from under it (foreign keys without cascade).
- **Paperwork** must be this business's, `stored`, and already linked to the
  container (`inventory_document_links.container_id`), so every attachment is
  reachable through the container's links even though a record names one main
  document. One invoice covering several jars is one document with a link per
  jar. PDFs are allowed (0048's document types).
- **Order lines**, when cited, decide the seller: the record's vendor is the
  order's vendor (filled in when not given, refused when different), and a
  line naming a product must name this container's product.
- **Never stock.** A purchase record is not a movement and cites none;
  recording, retrying or correcting one leaves every balance as it was. A
  retried request finds its first attempt by `idempotency_key`, unique per
  business.

Three facts stay distinct: the seller of THIS container (its current record);
the latest purchase of a product (the current records of its containers, by
`acquired_on`; when dates are unknown, the application says "most recently
recorded" rather than asserting an order); and the preferred vendor for future
purchases (`inventory_sourcing_preferences`, rank 1), which recording a
purchase never changes.

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
DROP FUNCTION IF EXISTS inventory_plan_requirements_rows();
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
  inventory_purchase_intents_rules(), inventory_sourcing_preferences_rules(), inventory_reservations_rules(),
  inventory_measurements_rules();
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

### 0049

Additive only: one new table with its indexes, two trigger functions, its
grant (SELECT, INSERT) and its tenant policy. No existing table, function,
policy or grant changes. It applies in the migrator's single transaction like
0048. Take the same logical dump first.

Withdrawal is emergency recovery only, never routine cleanup, and a forward
fix is preferred: withdrawal deletes the purchase records themselves. The
paperwork stays (documents and their links are 0048's), and so do the files in
the bucket. Run as the owner:

```sql
BEGIN;
DROP TABLE IF EXISTS inventory_container_acquisitions;
DROP FUNCTION IF EXISTS inventory_container_acquisitions_rules(), inventory_container_acquisitions_kept();
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1790003300000;
COMMIT;
```

A purchase record is never removed in normal operation, including after
acceptance on the live database: retire the synthetic container the way other
acceptance inventory is retired, and keep its purchase records as evidence.

## Status

| Layer | State |
| --- | --- |
| Schema, views, functions, triggers | 0048; container purchases 0049. |
| Tests | `test/inventory.test.ts`: migration re-runnable, policies and views, acceptance scenarios A02–A12 at the database level under the restricted role, and the regressions from the review of the first draft (7714b8f): reservations (R1), expiry-aware planning (R2), approvals (R3), weighing evidence (R4), shared photos (R5). `test/inventory-acquisitions.test.ts`: 0049 re-runnable, grants and policy; two jars of one lot from two sellers; first record, corrections, clearing and the single chain; price and currency; paperwork rules; order-line seller and product; records and what they cite kept; no stock change on record, retry or reuse; isolation. |
| Screens (capture, review, inventory list) | `10xid-com/app`, after this schema is copied there. |
| Live database | 0048 applied. 0049 not applied until review and approval. |
