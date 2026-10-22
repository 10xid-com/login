-- 0054: three plain tables to read the inventory by.
--
-- WHY. Paolo's decision of 2026-10-22: the inventory's 37 tables are too many
-- to read. He wants something simple to look at in the database itself.
--
-- WHAT IT DOES. Adds three read-only views, one row per thing, in plain words:
--
--   my_inventory  one row per container: what it is, how much is left and
--                 how that is known, sealed or open, where it is, its date
--                 and lot, when it was added.
--   my_products   one row per product: name, brand, maker, form, barcode,
--                 package size, how many containers are on the shelf.
--   my_purchases  one row per container's purchase as it stands now (a
--                 correction replaces what it corrects): seller, date,
--                 price, invoice.
--
-- They are views: they hold nothing of their own and always show what the
-- real tables hold now. Nothing underneath changes, and nothing writes to
-- them. Each row names its business.
--
-- WHO CAN READ THEM. The database owner (Railway's Data tab). They are
-- security_invoker, like 0048's views, so if a role is ever granted them,
-- each table's row-level security still applies to that role. No grant is
-- made here: the portal does not use them.
--
-- IDEMPOTENT. CREATE OR REPLACE.

CREATE OR REPLACE VIEW "my_inventory" WITH (security_invoker = true) AS
SELECT o.name AS business,
       p.name AS product,
       br.name AS brand,
       CASE
         WHEN b.balance IS NULL OR b.balance_basis = 'unknown' THEN 'Unknown'
         ELSE trim_scale(round(b.balance, 1))::text || ' '
              || CASE b.base_unit WHEN 'count' THEN 'items' ELSE b.base_unit END
       END AS amount_left,
       CASE b.balance_basis
         WHEN 'labelled_unopened' THEN 'as the label says'
         WHEN 'measured' THEN 'weighed'
         WHEN 'estimated' THEN 'estimate'
         WHEN 'calculated' THEN 'calculated'
         ELSE 'not known yet'
       END AS how_known,
       CASE c.status WHEN 'sealed' THEN 'Sealed' WHEN 'open' THEN 'Open' WHEN 'empty' THEN 'Empty' ELSE 'Gone' END AS status,
       CASE WHEN c.nominal_quantity IS NULL THEN NULL
            ELSE trim_scale(c.nominal_quantity)::text || ' ' || CASE c.nominal_unit WHEN 'count' THEN 'items' ELSE c.nominal_unit END
       END AS label_size,
       loc.name AS location,
       l.expiry_date,
       CASE l.expiry_kind WHEN 'best_before' THEN 'best before' WHEN 'expiry' THEN 'expires' WHEN 'use_by' THEN 'use by' ELSE NULL END AS expiry_kind,
       l.lot_code AS lot,
       c.opened_on,
       (c.created_at AT TIME ZONE 'America/Toronto')::date AS added_on,
       c.notes,
       c.id AS container_id
  FROM inventory_container_balances b
  JOIN inventory_containers c ON c.organization_id = b.organization_id AND c.id = b.container_id
  JOIN inventory_lots l ON l.organization_id = c.organization_id AND l.id = c.lot_id
  JOIN inventory_products p ON p.organization_id = l.organization_id AND p.id = l.product_id
  JOIN organizations o ON o.id = c.organization_id
  LEFT JOIN inventory_brands br ON br.organization_id = p.organization_id AND br.id = p.brand_id
  LEFT JOIN inventory_locations loc ON loc.organization_id = c.organization_id AND loc.id = c.location_id;

--> statement-breakpoint

CREATE OR REPLACE VIEW "my_products" WITH (security_invoker = true) AS
SELECT o.name AS business,
       p.name AS product,
       p.variant,
       br.name AS brand,
       maker.name AS made_by,
       CASE p.form WHEN 'unknown' THEN NULL ELSE replace(p.form, '_', ' ') END AS form,
       p.gtin AS barcode,
       CASE WHEN p.package_quantity IS NULL THEN NULL
            ELSE trim_scale(p.package_quantity)::text || ' ' || CASE p.package_unit WHEN 'count' THEN 'items' ELSE p.package_unit END
       END AS package_size,
       (SELECT count(*) FROM inventory_containers c
          JOIN inventory_lots l ON l.organization_id = c.organization_id AND l.id = c.lot_id
         WHERE l.organization_id = p.organization_id AND l.product_id = p.id
           AND c.status IN ('sealed', 'open'))::int AS containers_on_shelf,
       (p.created_at AT TIME ZONE 'America/Toronto')::date AS added_on,
       p.id AS product_id
  FROM inventory_products p
  JOIN organizations o ON o.id = p.organization_id
  LEFT JOIN inventory_brands br ON br.organization_id = p.organization_id AND br.id = p.brand_id
  LEFT JOIN inventory_businesses mb ON mb.organization_id = p.organization_id AND mb.id = p.manufacturer_id
  LEFT JOIN organizations maker ON maker.id = mb.company_id
 WHERE p.archived_at IS NULL;

--> statement-breakpoint

CREATE OR REPLACE VIEW "my_purchases" WITH (security_invoker = true) AS
SELECT o.name AS business,
       p.name AS product,
       br.name AS brand,
       seller.name AS bought_from,
       a.acquired_on AS bought_on,
       a.price,
       a.currency,
       d.original_name AS invoice,
       a.note,
       (a.created_at AT TIME ZONE 'America/Toronto')::date AS recorded_on,
       a.container_id
  FROM inventory_container_acquisitions a
  JOIN inventory_containers c ON c.organization_id = a.organization_id AND c.id = a.container_id
  JOIN inventory_lots l ON l.organization_id = c.organization_id AND l.id = c.lot_id
  JOIN inventory_products p ON p.organization_id = l.organization_id AND p.id = l.product_id
  JOIN organizations o ON o.id = a.organization_id
  LEFT JOIN inventory_brands br ON br.organization_id = p.organization_id AND br.id = p.brand_id
  LEFT JOIN inventory_businesses vb ON vb.organization_id = a.organization_id AND vb.id = a.vendor_id
  LEFT JOIN organizations seller ON seller.id = vb.company_id
  LEFT JOIN inventory_documents d ON d.organization_id = a.organization_id AND d.id = a.document_id
 WHERE NOT EXISTS (
   SELECT 1 FROM inventory_container_acquisitions s
    WHERE s.organization_id = a.organization_id AND s.supersedes_id = a.id);
