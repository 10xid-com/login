-- 0049: how each container was acquired — who sold it, when, for how much, and
-- the paperwork — recorded per CONTAINER, as known, with its history.
--
-- Why a table of its own (docs/inventory.md, "Purchases of a container"):
--
--   * Per container, never per lot or product. A lot is shared by every
--     container of one product, lot code and date, so two jars of one lot
--     bought from two sellers at two prices would be misattributed on the lot
--     (inventory_lots.receipt_line_id). An invoice covers many products, and a
--     document link names one record, so a container's purchase cannot be
--     derived from shared paperwork.
--   * Every fact optional. A person may know the price and date but not the
--     seller, or the seller without an invoice. inventory_orders needs a
--     vendor and defaults its currency, so recording these as orders would
--     invent an "unknown vendor" or a currency. order_line_id is the bridge
--     for when a purchase is also recorded as an order (an imported invoice).
--   * Never stock. This is not a movement and cites none: recording, or
--     correcting, how a container was bought adds nothing to what is in it.
--
-- A record is a full snapshot of what is known. A correction is a new record
-- that supersedes the one it corrects — one linear chain per container, the
-- earlier records kept and never changed — and may clear a wrong seller, price
-- or date back to unknown. The first record of a container must say something.

CREATE TABLE IF NOT EXISTS "inventory_container_acquisitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "container_id" uuid NOT NULL,
  "supersedes_id" uuid,
  "vendor_id" uuid,
  "order_line_id" uuid,
  "document_id" uuid,
  "acquired_on" date,
  "price" numeric(12, 2),
  "currency" char(3),
  "note" text,
  "idempotency_key" text,
  "recorded_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "inventory_container_acquisitions_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_container_acquisitions_container" FOREIGN KEY ("organization_id", "container_id")
    REFERENCES "inventory_containers" ("organization_id", "id"),
  CONSTRAINT "inventory_container_acquisitions_supersedes" FOREIGN KEY ("organization_id", "supersedes_id")
    REFERENCES "inventory_container_acquisitions" ("organization_id", "id"),
  CONSTRAINT "inventory_container_acquisitions_vendor" FOREIGN KEY ("organization_id", "vendor_id")
    REFERENCES "inventory_businesses" ("organization_id", "id"),
  CONSTRAINT "inventory_container_acquisitions_order_line" FOREIGN KEY ("organization_id", "order_line_id")
    REFERENCES "inventory_order_lines" ("organization_id", "id"),
  CONSTRAINT "inventory_container_acquisitions_document" FOREIGN KEY ("organization_id", "document_id")
    REFERENCES "inventory_documents" ("organization_id", "id"),
  -- The price of this one package as recorded (no shipping or tax shared out),
  -- never without its currency, and no currency without a price. A number:
  -- numeric accepts 'NaN', which PostgreSQL sorts above every number, so
  -- ">= 0" alone would let it through (infinities are refused by the type).
  CONSTRAINT "inventory_container_acquisitions_price" CHECK ("price" IS NULL OR ("price" >= 0 AND "price" <> 'NaN'::numeric)),
  CONSTRAINT "inventory_container_acquisitions_currency" CHECK (
    ("price" IS NULL) = ("currency" IS NULL) AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$')
  ),
  -- A first record says something; a correction may clear everything back to unknown.
  CONSTRAINT "inventory_container_acquisitions_says_something" CHECK (
    "supersedes_id" IS NOT NULL
    OR num_nonnulls("vendor_id", "order_line_id", "document_id", "acquired_on", "price", nullif(btrim("note"), '')) >= 1
  ),
  CONSTRAINT "inventory_container_acquisitions_not_itself" CHECK ("supersedes_id" IS DISTINCT FROM "id"),
  -- The same request is recorded once.
  CONSTRAINT "inventory_container_acquisitions_once" UNIQUE ("organization_id", "idempotency_key"),
  -- A record is corrected at most once: the chain cannot fork.
  CONSTRAINT "inventory_container_acquisitions_superseded_once" UNIQUE ("organization_id", "supersedes_id")
);

--> statement-breakpoint

-- One first record per container: with superseded-once, one linear chain.
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_container_acquisitions_one_first"
  ON "inventory_container_acquisitions" ("organization_id", "container_id") WHERE "supersedes_id" IS NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_container_acquisitions_container_idx"
  ON "inventory_container_acquisitions" ("organization_id", "container_id", "created_at");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_container_acquisitions_vendor_idx"
  ON "inventory_container_acquisitions" ("organization_id", "vendor_id") WHERE "vendor_id" IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_container_acquisitions_document_idx"
  ON "inventory_container_acquisitions" ("organization_id", "document_id") WHERE "document_id" IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_container_acquisitions_order_line_idx"
  ON "inventory_container_acquisitions" ("organization_id", "order_line_id") WHERE "order_line_id" IS NOT NULL;

--> statement-breakpoint

-- What a record may cite:
--   * a correction supersedes an EARLIER record of the SAME container (one that
--     already exists, so no statement can write a loop of corrections);
--   * its paperwork is a stored document already linked to this container, so
--     every attachment stays reachable through the container's links;
--   * an order line's seller is its order's vendor (filled in when not given,
--     refused when different), and a line naming a product names this
--     container's product.
-- A document, order line or container that is not this business's is refused
-- by its foreign key; these rules only judge rows the business can see.
CREATE OR REPLACE FUNCTION "inventory_container_acquisitions_rules"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  earlier_container uuid;
  document_state text;
  line_vendor uuid;
  line_product uuid;
  container_product uuid;
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT a.container_id INTO earlier_container FROM inventory_container_acquisitions a
     WHERE a.organization_id = NEW.organization_id AND a.id = NEW.supersedes_id;
    IF earlier_container IS DISTINCT FROM NEW.container_id THEN
      RAISE EXCEPTION 'A correction replaces an earlier record of the same container.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.document_id IS NOT NULL THEN
    SELECT d.state INTO document_state FROM inventory_documents d
     WHERE d.organization_id = NEW.organization_id AND d.id = NEW.document_id;
    IF FOUND THEN
      IF document_state <> 'stored' THEN
        RAISE EXCEPTION 'That document has not finished arriving.' USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM inventory_document_links l
         WHERE l.organization_id = NEW.organization_id AND l.document_id = NEW.document_id
           AND l.container_id = NEW.container_id
      ) THEN
        RAISE EXCEPTION 'Attach the document to this container first.' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW.order_line_id IS NOT NULL THEN
    SELECT o.vendor_id, ol.product_id INTO line_vendor, line_product
      FROM inventory_order_lines ol
      JOIN inventory_orders o ON o.organization_id = ol.organization_id AND o.id = ol.order_id
     WHERE ol.organization_id = NEW.organization_id AND ol.id = NEW.order_line_id;
    IF FOUND THEN
      IF NEW.vendor_id IS NULL THEN
        NEW.vendor_id := line_vendor;
      ELSIF NEW.vendor_id <> line_vendor THEN
        RAISE EXCEPTION 'That order line was bought from a different seller.' USING ERRCODE = 'check_violation';
      END IF;
      IF line_product IS NOT NULL THEN
        SELECT lo.product_id INTO container_product
          FROM inventory_containers c
          JOIN inventory_lots lo ON lo.organization_id = c.organization_id AND lo.id = c.lot_id
         WHERE c.organization_id = NEW.organization_id AND c.id = NEW.container_id;
        IF FOUND AND container_product IS DISTINCT FROM line_product THEN
          RAISE EXCEPTION 'That order line is for a different product.' USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS "inventory_container_acquisitions_rules" ON "inventory_container_acquisitions";

--> statement-breakpoint

CREATE TRIGGER "inventory_container_acquisitions_rules"
  BEFORE INSERT ON "inventory_container_acquisitions"
  FOR EACH ROW
  EXECUTE FUNCTION "inventory_container_acquisitions_rules"();

--> statement-breakpoint

-- A record, once written, is history: never changed, never removed.
CREATE OR REPLACE FUNCTION "inventory_container_acquisitions_kept"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'A purchase record is kept as it was written. Record a correction instead.'
    USING ERRCODE = 'check_violation';
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS "inventory_container_acquisitions_kept" ON "inventory_container_acquisitions";

--> statement-breakpoint

CREATE TRIGGER "inventory_container_acquisitions_kept"
  BEFORE UPDATE OR DELETE ON "inventory_container_acquisitions"
  FOR EACH ROW
  EXECUTE FUNCTION "inventory_container_acquisitions_kept"();

--> statement-breakpoint

-- Append-only for the application, like the ledger.
GRANT SELECT, INSERT ON "inventory_container_acquisitions" TO portal_app;

--> statement-breakpoint

ALTER TABLE "inventory_container_acquisitions" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

DROP POLICY IF EXISTS "inventory_container_acquisitions_tenant_isolation" ON "inventory_container_acquisitions";

--> statement-breakpoint

CREATE POLICY "inventory_container_acquisitions_tenant_isolation" ON "inventory_container_acquisitions"
  FOR ALL TO portal_app
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
