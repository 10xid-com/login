-- 0048: INVENTORY. What a business owns, what each thing is, where it came
-- from, what is left of it, and what to order before a dated batch.
--
-- Read docs/inventory.md before this file. It is the WHY and this is only the
-- HOW; where the two disagree the document wins and this file is wrong.
--
-- Nothing here is specific to one trade: a "material" is anything bought,
-- stored and used up in measured amounts — powders and ingredients, or a print
-- shop's vinyl. Nutrients are kept apart from materials because what a product
-- CONTAINS is a different fact from what it IS.
--
-- SIX RULES ARE ENFORCED HERE RATHER THAN IN TYPESCRIPT, because each of them
-- is one script away from being bypassed if it lives in the application:
--
--   1. Every inventory row belongs to one business and the database decides who
--      reads it: tenant isolation on app.org_id, failing closed, like every
--      other client table. There is deliberately NO staff read policy. This is
--      a business's private stock and paperwork, not client work.
--   2. A row can only point at rows of the SAME business. Every parent carries
--      UNIQUE (organization_id, id) and every child references that pair, so a
--      product of one business cannot name another's brand even by guessing
--      its uuid. A tenant policy checks only a row's own organization_id; this
--      is what closes the gap between the two.
--   3. Vendors, suppliers and manufacturers are COMPANIES: rows in
--      `organizations`, one per real company however many roles it plays, each
--      able to hold its own 10XiD iD. Type `listed` marks a company 10XiD knows
--      about that has not claimed an account. Listing one creates no user, no
--      membership and no invitation. As everywhere else, nothing references an
--      iD code: links point at organizations.id, so reissuing a code cannot
--      re-point anybody's purchases or stock.
--   4. Stock is a LEDGER. A container's balance is its latest anchor (opening,
--      receipt, fill, production output or count) plus the changes recorded
--      after it. The application may add events but never edit or delete one;
--      a mistake is voided by a reversal. An opening whose amount is unknown
--      leaves the balance UNKNOWN, not zero, until something is counted. A
--      retried request carries the same idempotency key and finds its first
--      attempt, and a container can be opened, or received, exactly once.
--   5. A formulation version is frozen once it leaves draft, and a batch can
--      only be made from a frozen version, so a recorded batch can always be
--      reproduced exactly.
--   6. Nothing is approved for purchase except by a person who belongs to the
--      business. An agent (a service account) may propose, and may later move
--      an approved purchase into a cart, but cannot approve it.
--
-- Unknown is not zero anywhere: quantities, prices, dates and tares are
-- nullable, and every derived balance says whether it is measured, estimated,
-- taken from an unopened label, or unknown.
--
-- THIS FILE IS RE-RUNNABLE, like 0015: every statement is guarded, so applying
-- it twice succeeds and changes nothing the second time.

--> statement-breakpoint

-- ===========================================================================
-- 1. COMPANIES AND THEIR iDs
-- ===========================================================================

-- A company 10XiD knows about but that has not claimed an account: a vendor,
-- supplier or manufacturer somebody buys from. It has no members, no domains,
-- no sign-in. Claiming one later is a separate, verified flow.
--
-- Not used anywhere else in this file: a value added by ALTER TYPE cannot be
-- used in the transaction that adds it, and the migrator applies every pending
-- file in one transaction.
ALTER TYPE "public"."organization_type" ADD VALUE IF NOT EXISTS 'listed';

--> statement-breakpoint

-- An iD can now be held by a company as well as by a person. Exactly one of the
-- two, never both: the rules of 0009 carry over unchanged — at most one live iD
-- per holder, and a code is unique forever across people AND companies, so a
-- code that once named somebody can never name something else.
ALTER TABLE "identities" ADD COLUMN IF NOT EXISTS "organization_id" uuid REFERENCES "organizations"("id");

--> statement-breakpoint

ALTER TABLE "identities" ALTER COLUMN "user_id" DROP NOT NULL;

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identities_exactly_one_holder') THEN
    ALTER TABLE "identities" ADD CONSTRAINT "identities_exactly_one_holder"
      CHECK (num_nonnulls("user_id", "organization_id") = 1);
  END IF;
END
$$;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "identities_one_live_per_organization"
  ON "identities" ("organization_id")
  WHERE "revoked_at" IS NULL AND "organization_id" IS NOT NULL;

--> statement-breakpoint

-- A listed company is NAMED, never joined. It has no members and no pending
-- invitations, so holding an iD can never become a sign-in or a way into
-- anybody's data. Claiming a listed company is a separate, verified change of
-- its type, after which memberships work as for any client.
CREATE OR REPLACE FUNCTION "listed_companies_have_no_members"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM organizations o WHERE o.id = NEW.organization_id AND o.type::text = 'listed') THEN
    RAISE EXCEPTION 'A listed company has no members or invitations; it must be claimed first (company %)', NEW.organization_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS "memberships_not_for_listed_companies" ON "memberships";

--> statement-breakpoint

CREATE TRIGGER "memberships_not_for_listed_companies"
  BEFORE INSERT OR UPDATE OF "organization_id" ON "memberships"
  FOR EACH ROW
  EXECUTE FUNCTION "listed_companies_have_no_members"();

--> statement-breakpoint

DROP TRIGGER IF EXISTS "invitations_not_for_listed_companies" ON "invitations";

--> statement-breakpoint

CREATE TRIGGER "invitations_not_for_listed_companies"
  BEFORE INSERT OR UPDATE OF "organization_id" ON "invitations"
  FOR EACH ROW
  EXECUTE FUNCTION "listed_companies_have_no_members"();

--> statement-breakpoint

-- A fresh code. 10X- and five characters of Crockford base32 (no I, L, O or U,
-- so it can be read aloud and typed from a label), following the example in
-- the identities documentation. 32^5 = 33.5 million codes; a collision simply
-- draws again. Randomness comes from gen_random_uuid(), whose first five bytes
-- are fully random; 256 is a multiple of 32, so every character is uniform.
CREATE OR REPLACE FUNCTION "next_id_code"() RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea;
  code text;
BEGIN
  LOOP
    bytes := uuid_send(gen_random_uuid());
    code := '10X-'
      || substr(alphabet, get_byte(bytes, 0) % 32 + 1, 1)
      || substr(alphabet, get_byte(bytes, 1) % 32 + 1, 1)
      || substr(alphabet, get_byte(bytes, 2) % 32 + 1, 1)
      || substr(alphabet, get_byte(bytes, 3) % 32 + 1, 1)
      || substr(alphabet, get_byte(bytes, 4) % 32 + 1, 1);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM identities i WHERE i.id_code = code);
  END LOOP;
  RETURN code;
END
$$;

--> statement-breakpoint

-- Who may touch a company's iD.
--
--   * The application may ISSUE an iD to a LISTED company, and only while it
--     holds none. A client's or the house's iD is an operator's decision.
--   * Only an operator (the table owner) may revoke, reissue or otherwise
--     change a company's iD. One business must not be able to rename a vendor
--     every other business also buys from.
--
-- People's iDs are untouched by this trigger.
CREATE OR REPLACE FUNCTION "identities_company_rules"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  table_owner oid;
  is_owner boolean;
  company_type text;
BEGIN
  SELECT relowner INTO table_owner FROM pg_class WHERE oid = TG_RELID;
  is_owner := pg_has_role(current_user, table_owner, 'USAGE');

  IF TG_OP = 'INSERT' THEN
    IF NEW.organization_id IS NOT NULL AND NOT is_owner THEN
      SELECT o.type::text INTO company_type FROM organizations o WHERE o.id = NEW.organization_id;
      IF company_type IS DISTINCT FROM 'listed' THEN
        RAISE EXCEPTION 'Only an operator issues an iD to a client or house company (company %)', NEW.organization_id
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF (OLD.organization_id IS NOT NULL OR NEW.organization_id IS DISTINCT FROM OLD.organization_id)
     AND NOT is_owner THEN
    RAISE EXCEPTION 'Only an operator changes a company''s iD (company %)', coalesce(OLD.organization_id, NEW.organization_id)
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS "identities_company_rules" ON "identities";

--> statement-breakpoint

CREATE TRIGGER "identities_company_rules"
  BEFORE INSERT OR UPDATE ON "identities"
  FOR EACH ROW
  EXECUTE FUNCTION "identities_company_rules"();

--> statement-breakpoint

-- Issue an iD to a listed company that holds none. Returns the live code, so a
-- retry after a dropped connection gets the same answer instead of an error.
-- SECURITY INVOKER: it runs as the caller, inside the rules above.
CREATE OR REPLACE FUNCTION "issue_company_id"(company uuid) RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  code text;
BEGIN
  SELECT i.id_code INTO code FROM identities i
   WHERE i.organization_id = company AND i.revoked_at IS NULL;
  IF code IS NOT NULL THEN
    RETURN code;
  END IF;
  LOOP
    code := next_id_code();
    BEGIN
      INSERT INTO identities (organization_id, id_code) VALUES (company, code);
      RETURN code;
    EXCEPTION WHEN unique_violation THEN
      -- Either the code was taken between drawing and inserting (draw again),
      -- or a concurrent call issued this company its iD (return that one).
      SELECT i.id_code INTO code FROM identities i
       WHERE i.organization_id = company AND i.revoked_at IS NULL;
      IF code IS NOT NULL THEN
        RETURN code;
      END IF;
    END;
  END LOOP;
END
$$;

--> statement-breakpoint

-- List a company 10XiD did not know about and issue its iD, in one step.
-- Creates the organization (type `listed`, a slug derived from the name and
-- numbered if taken) and nothing else: no user, no membership, no invitation.
-- Searching for an existing company first is the caller's job; two companies
-- with one name are possible and must stay two.
CREATE OR REPLACE FUNCTION "list_company"(company_name text)
RETURNS TABLE (company_id uuid, company_code text)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  clean_name text := btrim(regexp_replace(coalesce(company_name, ''), '\s+', ' ', 'g'));
  base_slug text;
  candidate text;
  n integer := 1;
  new_id uuid;
BEGIN
  IF clean_name = '' OR length(clean_name) > 200 THEN
    RAISE EXCEPTION 'A company needs a name of 1 to 200 characters.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  base_slug := btrim(regexp_replace(lower(clean_name), '[^a-z0-9]+', '-', 'g'), '-');
  IF base_slug = '' THEN
    base_slug := 'company';
  END IF;
  candidate := base_slug;
  WHILE EXISTS (SELECT 1 FROM organizations o WHERE o.slug = candidate) LOOP
    n := n + 1;
    candidate := base_slug || '-' || n;
  END LOOP;

  INSERT INTO organizations (type, name, slug)
  VALUES ('listed', clean_name, candidate)
  RETURNING id INTO new_id;

  company_id := new_id;
  company_code := issue_company_id(new_id);
  RETURN NEXT;
END
$$;

--> statement-breakpoint

-- Operator only: retire a company's iD and issue a new one. Nothing else
-- changes — every purchase, offer and container still points at the same
-- organizations.id — which is the whole reason nothing references the code.
CREATE OR REPLACE FUNCTION "reissue_company_id"(company uuid) RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE identities SET revoked_at = now(), updated_at = now()
   WHERE organization_id = company AND revoked_at IS NULL;
  RETURN issue_company_id(company);
END
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION "next_id_code"(), "issue_company_id"(uuid), "list_company"(text), "reissue_company_id"(uuid) FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION "next_id_code"(), "issue_company_id"(uuid), "list_company"(text) TO portal_app;

--> statement-breakpoint

-- ===========================================================================
-- 2. UNITS (shared reference data, not one business's)
-- ===========================================================================

-- `to_base` is the size of one unit in its dimension's base: grams, millilitres,
-- items, kilocalories. Units of dimension `other` (a drop, an IU) have no fixed
-- size and never convert: 10 drops is not a number of millilitres, and 1000 IU
-- of vitamin D is not a number of milligrams.
--
-- Teaspoon and tablespoon are the metric 5 ml and 15 ml. Grams per tablespoon of
-- a particular mix is a measurement of that mix, never this conversion.
CREATE TABLE IF NOT EXISTS "inventory_units" (
  "code" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "dimension" text NOT NULL,
  "to_base" numeric(24, 12),
  CONSTRAINT "inventory_units_dimension" CHECK ("dimension" IN ('mass', 'volume', 'count', 'energy', 'other')),
  CONSTRAINT "inventory_units_to_base" CHECK (("dimension" = 'other') = ("to_base" IS NULL)),
  CONSTRAINT "inventory_units_to_base_positive" CHECK ("to_base" IS NULL OR "to_base" > 0)
);

--> statement-breakpoint

INSERT INTO "inventory_units" ("code", "name", "dimension", "to_base") VALUES
  ('mcg', 'microgram', 'mass', 0.000001),
  ('mg', 'milligram', 'mass', 0.001),
  ('g', 'gram', 'mass', 1),
  ('kg', 'kilogram', 'mass', 1000),
  ('oz', 'ounce', 'mass', 28.349523125),
  ('lb', 'pound', 'mass', 453.59237),
  ('ml', 'millilitre', 'volume', 1),
  ('l', 'litre', 'volume', 1000),
  ('tsp', 'teaspoon (5 ml)', 'volume', 5),
  ('tbsp', 'tablespoon (15 ml)', 'volume', 15),
  ('fl_oz', 'fluid ounce (US)', 'volume', 29.5735295625),
  ('count', 'each', 'count', 1),
  ('kcal', 'kilocalorie', 'energy', 1),
  ('kj', 'kilojoule', 'energy', 0.239005736137667),
  ('drop', 'drop', 'other', NULL),
  ('iu', 'international unit', 'other', NULL)
ON CONFLICT ("code") DO NOTHING;

--> statement-breakpoint

-- ===========================================================================
-- 3. WHAT THINGS ARE
-- ===========================================================================

-- Nutrients and compounds a product can CONTAIN — vitamin C, citicoline,
-- energy — as distinct from the material that was bought. An acerola powder is
-- a material; the vitamin C in it is a nutrient, in an amount that depends on
-- the product.
CREATE TABLE IF NOT EXISTS "inventory_nutrients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "kind" text DEFAULT 'compound' NOT NULL,
  "default_unit" text REFERENCES "inventory_units"("code"),
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_nutrients_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_nutrients_name" CHECK (btrim("name") <> ''),
  CONSTRAINT "inventory_nutrients_kind" CHECK ("kind" IN ('energy', 'macronutrient', 'vitamin', 'mineral', 'amino_acid', 'fatty_acid', 'compound', 'other'))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_nutrients_name_unique" ON "inventory_nutrients" ("organization_id", lower("name"));

--> statement-breakpoint

-- A material: the generic thing a recipe calls for and a product is made of.
-- `specification` carries what makes two similar materials different —
-- "whole powder" and "extract, low oxalate" are two beet materials, coconut
-- milk powder and coconut water powder are two coconut materials — and the
-- name-plus-specification pair is what must be unique. Nothing merges two
-- materials because their names look alike.
CREATE TABLE IF NOT EXISTS "inventory_materials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "specification" text,
  "category" text,
  "dimension" text DEFAULT 'mass' NOT NULL,
  "description" text,
  "archived_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_materials_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_materials_name" CHECK (btrim("name") <> ''),
  CONSTRAINT "inventory_materials_dimension" CHECK ("dimension" IN ('mass', 'volume', 'count'))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_materials_name_unique"
  ON "inventory_materials" ("organization_id", lower("name"), lower(coalesce("specification", '')))
  WHERE "archived_at" IS NULL;

--> statement-breakpoint

-- Other names a material goes by. An alias belongs to exactly one material per
-- business, so matching a label through an alias can propose one material,
-- never silently pick between two.
CREATE TABLE IF NOT EXISTS "inventory_material_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "material_id" uuid NOT NULL,
  "alias" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_material_aliases_material" FOREIGN KEY ("organization_id", "material_id")
    REFERENCES "inventory_materials" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_material_aliases_alias" CHECK (btrim("alias") <> '')
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_material_aliases_unique" ON "inventory_material_aliases" ("organization_id", lower("alias"));

--> statement-breakpoint

-- This business's relationship with a company: one row per company however
-- many roles it plays, so a company that makes, supplies and sells a product
-- is ONE company with three flags, not three companies. The company itself —
-- its name and its iD — is shared; the account number, contact details and
-- notes here are this business's alone.
CREATE TABLE IF NOT EXISTS "inventory_businesses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "company_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "is_vendor" boolean DEFAULT false NOT NULL,
  "is_supplier" boolean DEFAULT false NOT NULL,
  "is_manufacturer" boolean DEFAULT false NOT NULL,
  "is_brand_owner" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "customer_number" text,
  "website" text,
  "ordering_url" text,
  "phone" text,
  "email" text,
  "address" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_businesses_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_businesses_once" UNIQUE ("organization_id", "company_id"),
  CONSTRAINT "inventory_businesses_status" CHECK ("status" IN ('active', 'avoid', 'inactive'))
);

--> statement-breakpoint

-- A brand is a name on a package. Who owns it is a separate fact, often
-- unknown, and owning a brand does not make a company the manufacturer.
CREATE TABLE IF NOT EXISTS "inventory_brands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "owner_id" uuid,
  "website" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_brands_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_brands_owner" FOREIGN KEY ("organization_id", "owner_id")
    REFERENCES "inventory_businesses" ("organization_id", "id"),
  CONSTRAINT "inventory_brands_name" CHECK (btrim("name") <> '')
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_brands_name_unique" ON "inventory_brands" ("organization_id", lower("name"));

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inventory_formulations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "notes" text,
  "archived_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_formulations_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_formulations_name" CHECK (btrim("name") <> '')
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_formulations_name_unique"
  ON "inventory_formulations" ("organization_id", lower("name")) WHERE "archived_at" IS NULL;

--> statement-breakpoint

-- One exact product as sold: brand, variant, form and package size. The label's
-- distributor and its manufacturer are separate columns because they are
-- frequently different companies. `composition` says how much is known about
-- what is inside: a single material, a complete or partial breakdown, or
-- nothing yet — a bought premix is catalogued as itself without inventing its
-- proportions. A house blend is a product too, made from a formulation.
CREATE TABLE IF NOT EXISTS "inventory_products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "variant" text,
  "brand_id" uuid,
  "manufacturer_id" uuid,
  "distributor_id" uuid,
  "form" text DEFAULT 'unknown' NOT NULL,
  "composition" text DEFAULT 'unknown' NOT NULL,
  "package_quantity" numeric(14, 4),
  "package_unit" text REFERENCES "inventory_units"("code"),
  "gtin" text,
  "serving_quantity" numeric(14, 4),
  "serving_unit" text REFERENCES "inventory_units"("code"),
  "label_ingredients" text,
  "label_directions" text,
  "label_warnings" text,
  "allergens" text,
  "storage_instructions" text,
  "country_of_origin" text,
  "house_blend_formulation_id" uuid,
  "notes" text,
  "archived_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_products_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_products_brand" FOREIGN KEY ("organization_id", "brand_id")
    REFERENCES "inventory_brands" ("organization_id", "id"),
  CONSTRAINT "inventory_products_manufacturer" FOREIGN KEY ("organization_id", "manufacturer_id")
    REFERENCES "inventory_businesses" ("organization_id", "id"),
  CONSTRAINT "inventory_products_distributor" FOREIGN KEY ("organization_id", "distributor_id")
    REFERENCES "inventory_businesses" ("organization_id", "id"),
  CONSTRAINT "inventory_products_house_blend" FOREIGN KEY ("organization_id", "house_blend_formulation_id")
    REFERENCES "inventory_formulations" ("organization_id", "id"),
  CONSTRAINT "inventory_products_name" CHECK (btrim("name") <> ''),
  CONSTRAINT "inventory_products_form" CHECK ("form" IN ('powder', 'extract_powder', 'juice_powder', 'whole', 'cut', 'granules', 'crystals', 'liquid', 'capsules', 'tablets', 'other', 'unknown')),
  CONSTRAINT "inventory_products_composition" CHECK ("composition" IN ('single', 'complete', 'partial', 'unknown')),
  CONSTRAINT "inventory_products_package" CHECK (("package_quantity" IS NULL) = ("package_unit" IS NULL) AND ("package_quantity" IS NULL OR "package_quantity" > 0)),
  CONSTRAINT "inventory_products_serving" CHECK (("serving_quantity" IS NULL) = ("serving_unit" IS NULL) AND ("serving_quantity" IS NULL OR "serving_quantity" > 0)),
  CONSTRAINT "inventory_products_gtin" CHECK ("gtin" IS NULL OR "gtin" ~ '^[0-9]{8,14}$')
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_products_gtin_idx" ON "inventory_products" ("organization_id", "gtin") WHERE "gtin" IS NOT NULL;

--> statement-breakpoint

-- What a product is made of. A component with no amount says "it is in there;
-- the label does not say how much", which is the honest record for a premix.
-- Stock and requirement arithmetic only ever uses components WITH an amount.
CREATE TABLE IF NOT EXISTS "inventory_product_components" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "product_id" uuid NOT NULL,
  "material_id" uuid NOT NULL,
  "quantity" numeric(18, 8),
  "unit" text REFERENCES "inventory_units"("code"),
  "per_quantity" numeric(18, 8),
  "per_unit" text REFERENCES "inventory_units"("code"),
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_product_components_product" FOREIGN KEY ("organization_id", "product_id")
    REFERENCES "inventory_products" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_product_components_material" FOREIGN KEY ("organization_id", "material_id")
    REFERENCES "inventory_materials" ("organization_id", "id"),
  CONSTRAINT "inventory_product_components_once" UNIQUE ("organization_id", "product_id", "material_id"),
  CONSTRAINT "inventory_product_components_amount" CHECK (
    ("quantity" IS NULL AND "unit" IS NULL AND "per_quantity" IS NULL AND "per_unit" IS NULL)
    OR ("quantity" IS NOT NULL AND "unit" IS NOT NULL AND "per_quantity" IS NOT NULL AND "per_unit" IS NOT NULL
        AND "quantity" >= 0 AND "per_quantity" > 0)
  )
);

--> statement-breakpoint

-- ===========================================================================
-- 4. BUYING: OFFERS, PREFERENCES, ORDERS, RECEIPTS
-- ===========================================================================

-- A vendor's listing of one product at one package size, with the date each
-- fact was last checked. Stock status and price are only as good as their date.
CREATE TABLE IF NOT EXISTS "inventory_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "vendor_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "vendor_sku" text,
  "url" text,
  "package_quantity" numeric(14, 4),
  "package_unit" text REFERENCES "inventory_units"("code"),
  "price" numeric(12, 2),
  "currency" char(3) DEFAULT 'CAD' NOT NULL,
  "price_checked_at" timestamp with time zone,
  "stock_status" text DEFAULT 'unknown' NOT NULL,
  "stock_checked_at" timestamp with time zone,
  "lead_time_days" integer,
  "lead_time_basis" text DEFAULT 'unknown' NOT NULL,
  "minimum_order" text,
  "notes" text,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_offers_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_offers_vendor" FOREIGN KEY ("organization_id", "vendor_id")
    REFERENCES "inventory_businesses" ("organization_id", "id"),
  CONSTRAINT "inventory_offers_product" FOREIGN KEY ("organization_id", "product_id")
    REFERENCES "inventory_products" ("organization_id", "id"),
  CONSTRAINT "inventory_offers_package" CHECK (("package_quantity" IS NULL) = ("package_unit" IS NULL) AND ("package_quantity" IS NULL OR "package_quantity" > 0)),
  CONSTRAINT "inventory_offers_price" CHECK ("price" IS NULL OR "price" >= 0),
  CONSTRAINT "inventory_offers_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "inventory_offers_stock" CHECK ("stock_status" IN ('in_stock', 'low_stock', 'out_of_stock', 'discontinued', 'unknown')),
  CONSTRAINT "inventory_offers_lead_time" CHECK ("lead_time_days" IS NULL OR "lead_time_days" >= 0),
  CONSTRAINT "inventory_offers_lead_time_basis" CHECK ("lead_time_basis" IN ('stated', 'observed', 'estimated', 'unknown')),
  CONSTRAINT "inventory_offers_url" CHECK ("url" IS NULL OR "url" ~* '^https?://')
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_offers_vendor_sku"
  ON "inventory_offers" ("organization_id", "vendor_id", "vendor_sku")
  WHERE "vendor_sku" IS NOT NULL AND "archived_at" IS NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_offers_product_idx" ON "inventory_offers" ("organization_id", "product_id");

--> statement-breakpoint

-- Where to buy a material (or one exact product), ranked: 1 is preferred, 2 and
-- on are the alternatives in order. A ranking says where this business would
-- rather buy; it is not evidence that the products are equivalent, which is why
-- a preference can only name a product that actually contains the material.
CREATE TABLE IF NOT EXISTS "inventory_sourcing_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "material_id" uuid,
  "product_id" uuid,
  "rank" smallint NOT NULL,
  "vendor_id" uuid NOT NULL,
  "offer_id" uuid,
  "reason" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_sourcing_preferences_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_sourcing_preferences_material" FOREIGN KEY ("organization_id", "material_id")
    REFERENCES "inventory_materials" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_sourcing_preferences_product" FOREIGN KEY ("organization_id", "product_id")
    REFERENCES "inventory_products" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_sourcing_preferences_vendor" FOREIGN KEY ("organization_id", "vendor_id")
    REFERENCES "inventory_businesses" ("organization_id", "id"),
  CONSTRAINT "inventory_sourcing_preferences_offer" FOREIGN KEY ("organization_id", "offer_id")
    REFERENCES "inventory_offers" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_sourcing_preferences_subject" CHECK ("material_id" IS NOT NULL OR "product_id" IS NOT NULL),
  CONSTRAINT "inventory_sourcing_preferences_rank" CHECK ("rank" >= 1)
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_sourcing_preferences_material_rank"
  ON "inventory_sourcing_preferences" ("organization_id", "material_id", "rank")
  WHERE "active" AND "material_id" IS NOT NULL AND "product_id" IS NULL;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_sourcing_preferences_product_rank"
  ON "inventory_sourcing_preferences" ("organization_id", "product_id", "rank")
  WHERE "active" AND "product_id" IS NOT NULL;

--> statement-breakpoint

-- An order or invoice from a vendor. Importing the same order or invoice twice
-- finds the first (unique per vendor). An order is not a delivery: nothing here
-- adds stock. `vendor_code` keeps the vendor's iD as it was when the order was
-- recorded, for the paperwork; the link itself is vendor_id.
CREATE TABLE IF NOT EXISTS "inventory_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "vendor_id" uuid NOT NULL,
  "vendor_code" text,
  "order_number" text,
  "invoice_number" text,
  "ordered_on" date,
  "expected_on" date,
  "status" text DEFAULT 'placed' NOT NULL,
  "currency" char(3) DEFAULT 'CAD' NOT NULL,
  "subtotal" numeric(12, 2),
  "discount" numeric(12, 2),
  "shipping" numeric(12, 2),
  "tax" numeric(12, 2),
  "total" numeric(12, 2),
  "notes" text,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_orders_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_orders_vendor" FOREIGN KEY ("organization_id", "vendor_id")
    REFERENCES "inventory_businesses" ("organization_id", "id"),
  CONSTRAINT "inventory_orders_status" CHECK ("status" IN ('draft', 'placed', 'partially_received', 'received', 'cancelled', 'disputed')),
  CONSTRAINT "inventory_orders_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "inventory_orders_amounts" CHECK (
    coalesce("subtotal", 0) >= 0 AND coalesce("discount", 0) >= 0 AND coalesce("shipping", 0) >= 0
    AND coalesce("tax", 0) >= 0 AND coalesce("total", 0) >= 0
  )
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_orders_number"
  ON "inventory_orders" ("organization_id", "vendor_id", "order_number") WHERE "order_number" IS NOT NULL;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_orders_invoice"
  ON "inventory_orders" ("organization_id", "vendor_id", "invoice_number") WHERE "invoice_number" IS NOT NULL;

--> statement-breakpoint

-- Keeps the paperwork's copy of the vendor's iD. Fills `vendor_code` from the
-- vendor's live iD when the caller did not supply one; never changes it after.
CREATE OR REPLACE FUNCTION "inventory_orders_vendor_code"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.vendor_code := OLD.vendor_code;
    IF NEW.vendor_id IS DISTINCT FROM OLD.vendor_id THEN
      RAISE EXCEPTION 'An order cannot be moved to another vendor; record a new order.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.vendor_code IS NULL THEN
    SELECT i.id_code INTO NEW.vendor_code
      FROM inventory_businesses b
      JOIN identities i ON i.organization_id = b.company_id AND i.revoked_at IS NULL
     WHERE b.organization_id = NEW.organization_id AND b.id = NEW.vendor_id;
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS "inventory_orders_vendor_code" ON "inventory_orders";

--> statement-breakpoint

CREATE TRIGGER "inventory_orders_vendor_code"
  BEFORE INSERT OR UPDATE ON "inventory_orders"
  FOR EACH ROW
  EXECUTE FUNCTION "inventory_orders_vendor_code"();

--> statement-breakpoint

-- One line of an order, as printed. Package COUNT and package SIZE are separate
-- columns: three bags is not three grams.
CREATE TABLE IF NOT EXISTS "inventory_order_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "order_id" uuid NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "description" text NOT NULL,
  "vendor_sku" text,
  "offer_id" uuid,
  "product_id" uuid,
  "packages" numeric(10, 3) NOT NULL,
  "package_quantity" numeric(14, 4),
  "package_unit" text REFERENCES "inventory_units"("code"),
  "unit_price" numeric(12, 4),
  "line_total" numeric(12, 2),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_order_lines_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_order_lines_order" FOREIGN KEY ("organization_id", "order_id")
    REFERENCES "inventory_orders" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_order_lines_offer" FOREIGN KEY ("organization_id", "offer_id")
    REFERENCES "inventory_offers" ("organization_id", "id"),
  CONSTRAINT "inventory_order_lines_product" FOREIGN KEY ("organization_id", "product_id")
    REFERENCES "inventory_products" ("organization_id", "id"),
  CONSTRAINT "inventory_order_lines_description" CHECK (btrim("description") <> ''),
  CONSTRAINT "inventory_order_lines_packages" CHECK ("packages" > 0),
  CONSTRAINT "inventory_order_lines_package" CHECK (("package_quantity" IS NULL) = ("package_unit" IS NULL) AND ("package_quantity" IS NULL OR "package_quantity" > 0)),
  CONSTRAINT "inventory_order_lines_prices" CHECK (coalesce("unit_price", 0) >= 0 AND coalesce("line_total", 0) >= 0)
);

--> statement-breakpoint

-- A delivery arriving. Receiving the same delivery twice finds the first by its
-- idempotency key, so a retried "received" adds nothing.
CREATE TABLE IF NOT EXISTS "inventory_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "order_id" uuid,
  "received_on" date DEFAULT CURRENT_DATE NOT NULL,
  "received_by" uuid REFERENCES "users"("id"),
  "idempotency_key" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_receipts_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_receipts_order" FOREIGN KEY ("organization_id", "order_id")
    REFERENCES "inventory_orders" ("organization_id", "id"),
  CONSTRAINT "inventory_receipts_once" UNIQUE ("organization_id", "idempotency_key")
);

--> statement-breakpoint

-- What actually arrived on one delivery, which may be less than ordered, may be
-- damaged, and may be a different product than the one ordered.
CREATE TABLE IF NOT EXISTS "inventory_receipt_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "receipt_id" uuid NOT NULL,
  "order_line_id" uuid,
  "product_id" uuid NOT NULL,
  "packages_accepted" numeric(10, 3) NOT NULL,
  "packages_rejected" numeric(10, 3) DEFAULT 0 NOT NULL,
  "condition" text DEFAULT 'ok' NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_receipt_lines_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_receipt_lines_receipt" FOREIGN KEY ("organization_id", "receipt_id")
    REFERENCES "inventory_receipts" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_receipt_lines_order_line" FOREIGN KEY ("organization_id", "order_line_id")
    REFERENCES "inventory_order_lines" ("organization_id", "id"),
  CONSTRAINT "inventory_receipt_lines_product" FOREIGN KEY ("organization_id", "product_id")
    REFERENCES "inventory_products" ("organization_id", "id"),
  CONSTRAINT "inventory_receipt_lines_counts" CHECK ("packages_accepted" >= 0 AND "packages_rejected" >= 0 AND "packages_accepted" + "packages_rejected" > 0),
  CONSTRAINT "inventory_receipt_lines_condition" CHECK ("condition" IN ('ok', 'damaged', 'wrong_item', 'substituted', 'short'))
);

--> statement-breakpoint

-- ===========================================================================
-- 5. PHYSICAL STOCK
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "inventory_locations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "description" text,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_locations_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_locations_name" CHECK (btrim("name") <> '')
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_locations_name_unique"
  ON "inventory_locations" ("organization_id", lower("name")) WHERE "archived_at" IS NULL;

--> statement-breakpoint

-- A lot: units of one product sharing a printed lot code and dates — or, when
-- nothing is printed or readable, simply "this product, lot unknown". Dates are
-- kept as printed beside the parsed date, with which kind of date it is.
-- `acquired_on` is the age stock is used in (oldest first) and is never reset
-- by moving the stock; it may be unknown for things already on the shelf.
-- `hold` is the decision about questionable stock — expired, damaged,
-- unidentified — and anything on hold never counts as usable.
CREATE TABLE IF NOT EXISTS "inventory_lots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "product_id" uuid NOT NULL,
  "lot_code" text,
  "expiry_printed" text,
  "expiry_kind" text,
  "expiry_date" date,
  "manufactured_on" date,
  "acquired_on" date,
  "acquired_on_estimated" boolean DEFAULT false NOT NULL,
  "receipt_line_id" uuid,
  "hold" text DEFAULT 'none' NOT NULL,
  "hold_reason" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_lots_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_lots_product" FOREIGN KEY ("organization_id", "product_id")
    REFERENCES "inventory_products" ("organization_id", "id"),
  CONSTRAINT "inventory_lots_receipt_line" FOREIGN KEY ("organization_id", "receipt_line_id")
    REFERENCES "inventory_receipt_lines" ("organization_id", "id"),
  CONSTRAINT "inventory_lots_expiry_kind" CHECK ("expiry_kind" IS NULL OR "expiry_kind" IN ('best_before', 'expiry', 'use_by', 'unknown')),
  CONSTRAINT "inventory_lots_expiry_has_kind" CHECK ("expiry_date" IS NULL OR "expiry_kind" IS NOT NULL),
  CONSTRAINT "inventory_lots_hold" CHECK ("hold" IN ('none', 'review', 'quarantine', 'discarded')),
  CONSTRAINT "inventory_lots_hold_reason" CHECK ("hold" = 'none' OR "hold_reason" IS NOT NULL)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_lots_fifo_idx" ON "inventory_lots" ("organization_id", "product_id", "acquired_on");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_lots_expiry_idx" ON "inventory_lots" ("organization_id", "expiry_date") WHERE "expiry_date" IS NOT NULL;

--> statement-breakpoint

-- One physical container. Two identical jars from one lot are two rows: nothing
-- here, or anywhere, merges containers because they look alike.
--
-- `nominal_*` is what the label says the package held when new. It is NOT what
-- is left: that is the ledger's job (the balances view), and an opened package
-- is never assumed to still hold its label weight. `dimension` fixes how this
-- container is measured; every stock event for it must use a unit of that
-- dimension.
CREATE TABLE IF NOT EXISTS "inventory_containers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "lot_id" uuid NOT NULL,
  "location_id" uuid,
  "code" text,
  "status" text DEFAULT 'sealed' NOT NULL,
  "dimension" text DEFAULT 'mass' NOT NULL,
  "nominal_quantity" numeric(14, 4),
  "nominal_unit" text REFERENCES "inventory_units"("code"),
  "tare_g" numeric(12, 3),
  "tare_basis" text DEFAULT 'unknown' NOT NULL,
  "opened_on" date,
  "emptied_on" date,
  "notes" text,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_containers_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_containers_lot" FOREIGN KEY ("organization_id", "lot_id")
    REFERENCES "inventory_lots" ("organization_id", "id"),
  CONSTRAINT "inventory_containers_location" FOREIGN KEY ("organization_id", "location_id")
    REFERENCES "inventory_locations" ("organization_id", "id"),
  CONSTRAINT "inventory_containers_status" CHECK ("status" IN ('sealed', 'open', 'empty', 'disposed')),
  CONSTRAINT "inventory_containers_dimension" CHECK ("dimension" IN ('mass', 'volume', 'count')),
  CONSTRAINT "inventory_containers_nominal" CHECK (("nominal_quantity" IS NULL) = ("nominal_unit" IS NULL) AND ("nominal_quantity" IS NULL OR "nominal_quantity" > 0)),
  CONSTRAINT "inventory_containers_tare" CHECK ("tare_g" IS NULL OR "tare_g" >= 0),
  CONSTRAINT "inventory_containers_tare_basis" CHECK ("tare_basis" IN ('measured', 'estimated', 'unknown') AND (("tare_g" IS NULL) = ("tare_basis" = 'unknown')))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_containers_code" ON "inventory_containers" ("organization_id", "code") WHERE "code" IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_containers_lot_idx" ON "inventory_containers" ("organization_id", "lot_id");

--> statement-breakpoint

-- A capture: one sitting in front of one physical container with a phone —
-- front, panel, lot and date, scale. Its photos and extraction belong to it,
-- and confirming it is what creates (or links) the container and records its
-- one opening event. Confirmation is final and happens once: a retried
-- confirmation finds the container this capture already made.
CREATE TABLE IF NOT EXISTS "inventory_captures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "status" text DEFAULT 'open' NOT NULL,
  "container_id" uuid,
  "outcome" text,
  "confirmed_by" uuid REFERENCES "users"("id"),
  "confirmed_at" timestamp with time zone,
  "notes" text,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_captures_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_captures_container" FOREIGN KEY ("organization_id", "container_id")
    REFERENCES "inventory_containers" ("organization_id", "id"),
  CONSTRAINT "inventory_captures_status" CHECK ("status" IN ('open', 'confirmed', 'abandoned')),
  CONSTRAINT "inventory_captures_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('new_container', 'existing_container')),
  CONSTRAINT "inventory_captures_confirmed" CHECK (
    ("status" = 'confirmed') = ("container_id" IS NOT NULL AND "outcome" IS NOT NULL AND "confirmed_at" IS NOT NULL)
  )
);

--> statement-breakpoint

-- A confirmed capture is history: it cannot be reopened or pointed elsewhere.
CREATE OR REPLACE FUNCTION "inventory_captures_rules"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'confirmed' AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.container_id IS DISTINCT FROM OLD.container_id
       OR NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
    RAISE EXCEPTION 'A confirmed capture is final.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS "inventory_captures_rules" ON "inventory_captures";

--> statement-breakpoint

CREATE TRIGGER "inventory_captures_rules"
  BEFORE UPDATE ON "inventory_captures"
  FOR EACH ROW
  EXECUTE FUNCTION "inventory_captures_rules"();

--> statement-breakpoint

-- ===========================================================================
-- 6. EVIDENCE: PHOTOS, DOCUMENTS, EXTRACTION AND REVIEW
-- ===========================================================================

-- A photo or document in the private store. The object key embeds the owning
-- business and is made by the portal, never taken from a request; the same
-- file uploaded twice by one business is one document (by content hash). The
-- row exists from the moment an upload starts, so a dropped connection leaves
-- a `pending` row to finish or retry rather than nothing.
--
-- Text inside a photo is evidence, never an instruction.
CREATE TABLE IF NOT EXISTS "inventory_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "capture_id" uuid,
  "kind" text NOT NULL,
  "content_type" text NOT NULL,
  "storage_key" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "sha256" bytea NOT NULL,
  "original_name" text,
  "captured_at" timestamp with time zone,
  "state" text DEFAULT 'pending' NOT NULL,
  "error" text,
  "uploaded_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_documents_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_documents_storage_key" UNIQUE ("storage_key"),
  CONSTRAINT "inventory_documents_same_file" UNIQUE ("organization_id", "sha256"),
  CONSTRAINT "inventory_documents_capture" FOREIGN KEY ("organization_id", "capture_id")
    REFERENCES "inventory_captures" ("organization_id", "id"),
  CONSTRAINT "inventory_documents_kind" CHECK ("kind" IN ('photo', 'invoice', 'receipt', 'packing_slip', 'certificate', 'other')),
  CONSTRAINT "inventory_documents_type" CHECK ("content_type" IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf')),
  CONSTRAINT "inventory_documents_size" CHECK ("byte_size" BETWEEN 1 AND 52428800),
  CONSTRAINT "inventory_documents_hash" CHECK (octet_length("sha256") = 32),
  CONSTRAINT "inventory_documents_key" CHECK ("storage_key" ~ '^inventory/[0-9a-f-]{36}/[A-Za-z0-9_-]{22,64}\.(jpg|png|webp|heic|pdf)$'),
  CONSTRAINT "inventory_documents_key_is_own" CHECK (split_part("storage_key", '/', 2) = "organization_id"::text),
  CONSTRAINT "inventory_documents_state" CHECK ("state" IN ('pending', 'stored', 'failed'))
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_documents_capture_idx" ON "inventory_documents" ("organization_id", "capture_id") WHERE "capture_id" IS NOT NULL;

--> statement-breakpoint

-- What a document is evidence OF: a product's label, a lot's date, a
-- container's weighing, an order's invoice. One document can support several
-- records and one record can have many documents; each link names one record.
CREATE TABLE IF NOT EXISTS "inventory_document_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "document_id" uuid NOT NULL,
  "product_id" uuid,
  "lot_id" uuid,
  "container_id" uuid,
  "order_id" uuid,
  "business_id" uuid,
  "offer_id" uuid,
  "role" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_document_links_document" FOREIGN KEY ("organization_id", "document_id")
    REFERENCES "inventory_documents" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_document_links_product" FOREIGN KEY ("organization_id", "product_id")
    REFERENCES "inventory_products" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_document_links_lot" FOREIGN KEY ("organization_id", "lot_id")
    REFERENCES "inventory_lots" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_document_links_container" FOREIGN KEY ("organization_id", "container_id")
    REFERENCES "inventory_containers" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_document_links_order" FOREIGN KEY ("organization_id", "order_id")
    REFERENCES "inventory_orders" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_document_links_business" FOREIGN KEY ("organization_id", "business_id")
    REFERENCES "inventory_businesses" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_document_links_offer" FOREIGN KEY ("organization_id", "offer_id")
    REFERENCES "inventory_offers" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_document_links_one_target" CHECK (num_nonnulls("product_id", "lot_id", "container_id", "order_id", "business_id", "offer_id") = 1)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_document_links_document_idx" ON "inventory_document_links" ("organization_id", "document_id");

--> statement-breakpoint

-- One run of a named extraction engine over a capture or a single document.
-- `engine` names the real model or service; a fixture is recorded as one.
CREATE TABLE IF NOT EXISTS "inventory_extractions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "capture_id" uuid,
  "document_id" uuid,
  "engine" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "raw_output" jsonb,
  "error" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "reviewed_by" uuid REFERENCES "users"("id"),
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_extractions_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_extractions_capture" FOREIGN KEY ("organization_id", "capture_id")
    REFERENCES "inventory_captures" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_extractions_document" FOREIGN KEY ("organization_id", "document_id")
    REFERENCES "inventory_documents" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_extractions_subject" CHECK ("capture_id" IS NOT NULL OR "document_id" IS NOT NULL),
  CONSTRAINT "inventory_extractions_status" CHECK ("status" IN ('queued', 'running', 'needs_review', 'reviewed', 'failed')),
  CONSTRAINT "inventory_extractions_reviewed" CHECK ("status" <> 'reviewed' OR ("reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL))
);

--> statement-breakpoint

-- Each value the engine read, exactly as read, with where on which photo it was
-- read from, how sure the engine was, and what the person decided.
CREATE TABLE IF NOT EXISTS "inventory_extracted_fields" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "extraction_id" uuid NOT NULL,
  "document_id" uuid,
  "field" text NOT NULL,
  "raw_text" text,
  "value" jsonb,
  "source_locator" jsonb,
  "confidence" numeric(4, 3),
  "review" text DEFAULT 'pending' NOT NULL,
  "corrected_value" jsonb,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_extracted_fields_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_extracted_fields_extraction" FOREIGN KEY ("organization_id", "extraction_id")
    REFERENCES "inventory_extractions" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_extracted_fields_document" FOREIGN KEY ("organization_id", "document_id")
    REFERENCES "inventory_documents" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_extracted_fields_field" CHECK (btrim("field") <> ''),
  CONSTRAINT "inventory_extracted_fields_confidence" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1),
  CONSTRAINT "inventory_extracted_fields_review" CHECK ("review" IN ('pending', 'accepted', 'corrected', 'rejected')),
  CONSTRAINT "inventory_extracted_fields_corrected" CHECK ("review" <> 'corrected' OR "corrected_value" IS NOT NULL)
);

--> statement-breakpoint

-- What the engine thinks the photographed thing IS: an existing product,
-- brand, material, company or container — or, with nothing to point at, a
-- proposed new one. A candidate is a suggestion with evidence until a person
-- accepts, rejects, defers or creates.
CREATE TABLE IF NOT EXISTS "inventory_match_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "extraction_id" uuid NOT NULL,
  "target" text NOT NULL,
  "product_id" uuid,
  "brand_id" uuid,
  "material_id" uuid,
  "business_id" uuid,
  "company_id" uuid REFERENCES "organizations"("id"),
  "container_id" uuid,
  "proposed" jsonb,
  "score" numeric(4, 3),
  "evidence" text,
  "decision" text DEFAULT 'pending' NOT NULL,
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_match_candidates_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_match_candidates_extraction" FOREIGN KEY ("organization_id", "extraction_id")
    REFERENCES "inventory_extractions" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_match_candidates_product" FOREIGN KEY ("organization_id", "product_id")
    REFERENCES "inventory_products" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_match_candidates_brand" FOREIGN KEY ("organization_id", "brand_id")
    REFERENCES "inventory_brands" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_match_candidates_material" FOREIGN KEY ("organization_id", "material_id")
    REFERENCES "inventory_materials" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_match_candidates_business" FOREIGN KEY ("organization_id", "business_id")
    REFERENCES "inventory_businesses" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_match_candidates_container" FOREIGN KEY ("organization_id", "container_id")
    REFERENCES "inventory_containers" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_match_candidates_target" CHECK ("target" IN ('product', 'brand', 'material', 'company', 'container')),
  CONSTRAINT "inventory_match_candidates_points_at_one" CHECK (
    num_nonnulls("product_id", "brand_id", "material_id", "business_id", "company_id", "container_id") <= 1
    AND (num_nonnulls("product_id", "brand_id", "material_id", "business_id", "company_id", "container_id") = 1 OR "proposed" IS NOT NULL)
  ),
  CONSTRAINT "inventory_match_candidates_score" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 1),
  CONSTRAINT "inventory_match_candidates_decision" CHECK ("decision" IN ('pending', 'accepted', 'rejected', 'deferred', 'created')),
  CONSTRAINT "inventory_match_candidates_decided" CHECK ("decision" IN ('pending', 'deferred') OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL))
);

--> statement-breakpoint

-- A weighing. Gross is the package on the scale; tare is the empty package;
-- net is what is inside. When both gross and tare are known, net IS their
-- difference. When the tare is missing, net is unknown unless explicitly
-- estimated — and even then it can never equal the gross, which is how a gross
-- figure gets mistaken for contents.
CREATE TABLE IF NOT EXISTS "inventory_measurements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "container_id" uuid NOT NULL,
  "measured_at" timestamp with time zone DEFAULT now() NOT NULL,
  "gross_g" numeric(12, 3),
  "tare_g" numeric(12, 3),
  "tare_basis" text,
  "net_g" numeric(12, 3),
  "method" text NOT NULL,
  "confidence" text NOT NULL,
  "document_id" uuid,
  "measured_by" uuid REFERENCES "users"("id"),
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_measurements_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_measurements_container" FOREIGN KEY ("organization_id", "container_id")
    REFERENCES "inventory_containers" ("organization_id", "id"),
  CONSTRAINT "inventory_measurements_document" FOREIGN KEY ("organization_id", "document_id")
    REFERENCES "inventory_documents" ("organization_id", "id"),
  CONSTRAINT "inventory_measurements_positive" CHECK (
    ("gross_g" IS NULL OR "gross_g" > 0) AND ("tare_g" IS NULL OR "tare_g" >= 0) AND ("net_g" IS NULL OR "net_g" >= 0)
  ),
  CONSTRAINT "inventory_measurements_tare_fits" CHECK ("gross_g" IS NULL OR "tare_g" IS NULL OR "tare_g" <= "gross_g"),
  CONSTRAINT "inventory_measurements_net_is_difference" CHECK (
    "gross_g" IS NULL OR "tare_g" IS NULL OR "net_g" IS NOT DISTINCT FROM "gross_g" - "tare_g"
  ),
  CONSTRAINT "inventory_measurements_gross_is_not_net" CHECK (
    "gross_g" IS NULL OR "tare_g" IS NOT NULL OR "net_g" IS NULL
    OR ("confidence" IN ('estimated', 'rough') AND "net_g" < "gross_g")
  ),
  CONSTRAINT "inventory_measurements_tare_basis" CHECK (
    ("tare_g" IS NULL AND "tare_basis" IS NULL) OR ("tare_g" IS NOT NULL AND "tare_basis" IN ('measured', 'estimated'))
  ),
  CONSTRAINT "inventory_measurements_something" CHECK ("gross_g" IS NOT NULL OR "net_g" IS NOT NULL),
  CONSTRAINT "inventory_measurements_method" CHECK ("method" IN ('scale', 'label', 'visual_estimate', 'calculated')),
  CONSTRAINT "inventory_measurements_confidence" CHECK ("confidence" IN ('exact', 'estimated', 'rough'))
);

--> statement-breakpoint

-- What a product declares it contains per serving or per 100 g, as printed,
-- with where that came from. Missing is missing, never zero.
CREATE TABLE IF NOT EXISTS "inventory_product_nutrients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "product_id" uuid NOT NULL,
  "nutrient_id" uuid NOT NULL,
  "amount" numeric(18, 6),
  "unit" text REFERENCES "inventory_units"("code"),
  "amount_printed" text,
  "per_quantity" numeric(14, 4) NOT NULL,
  "per_unit" text NOT NULL REFERENCES "inventory_units"("code"),
  "source" text NOT NULL,
  "document_id" uuid,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_product_nutrients_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_product_nutrients_product" FOREIGN KEY ("organization_id", "product_id")
    REFERENCES "inventory_products" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_product_nutrients_nutrient" FOREIGN KEY ("organization_id", "nutrient_id")
    REFERENCES "inventory_nutrients" ("organization_id", "id"),
  CONSTRAINT "inventory_product_nutrients_document" FOREIGN KEY ("organization_id", "document_id")
    REFERENCES "inventory_documents" ("organization_id", "id"),
  CONSTRAINT "inventory_product_nutrients_once" UNIQUE ("organization_id", "product_id", "nutrient_id", "per_quantity", "per_unit"),
  CONSTRAINT "inventory_product_nutrients_amount" CHECK (("amount" IS NULL) = ("unit" IS NULL) AND ("amount" IS NULL OR "amount" >= 0)),
  CONSTRAINT "inventory_product_nutrients_known" CHECK ("amount" IS NOT NULL OR "amount_printed" IS NOT NULL),
  CONSTRAINT "inventory_product_nutrients_per" CHECK ("per_quantity" > 0),
  CONSTRAINT "inventory_product_nutrients_source" CHECK ("source" IN ('label', 'vendor', 'document', 'calculated', 'user'))
);

--> statement-breakpoint

-- Claims kept with where they came from: a label saying "organic" is a label
-- claim; a certificate for a lot is a document. Nothing infers raw from
-- organic, or vegan from "natural".
CREATE TABLE IF NOT EXISTS "inventory_product_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "product_id" uuid NOT NULL,
  "lot_id" uuid,
  "claim" text NOT NULL,
  "wording" text,
  "source" text NOT NULL,
  "document_id" uuid,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_product_claims_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_product_claims_product" FOREIGN KEY ("organization_id", "product_id")
    REFERENCES "inventory_products" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_product_claims_lot" FOREIGN KEY ("organization_id", "lot_id")
    REFERENCES "inventory_lots" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_product_claims_document" FOREIGN KEY ("organization_id", "document_id")
    REFERENCES "inventory_documents" ("organization_id", "id"),
  CONSTRAINT "inventory_product_claims_claim" CHECK ("claim" IN ('organic', 'vegan', 'raw', 'non_gmo', 'fair_trade', 'gluten_free', 'kosher', 'halal', 'other')),
  CONSTRAINT "inventory_product_claims_other" CHECK ("claim" <> 'other' OR "wording" IS NOT NULL),
  CONSTRAINT "inventory_product_claims_source" CHECK ("source" IN ('label', 'vendor', 'document', 'verified', 'user'))
);

--> statement-breakpoint

-- Dated prices for an offer: from an invoice, the website, the shelf, a quote.
-- Historical prices are kept as they were, never overwritten by today's.
CREATE TABLE IF NOT EXISTS "inventory_offer_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "offer_id" uuid NOT NULL,
  "observed_on" date DEFAULT CURRENT_DATE NOT NULL,
  "price" numeric(12, 2) NOT NULL,
  "currency" char(3) DEFAULT 'CAD' NOT NULL,
  "source" text NOT NULL,
  "order_line_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_offer_prices_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_offer_prices_offer" FOREIGN KEY ("organization_id", "offer_id")
    REFERENCES "inventory_offers" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_offer_prices_order_line" FOREIGN KEY ("organization_id", "order_line_id")
    REFERENCES "inventory_order_lines" ("organization_id", "id"),
  CONSTRAINT "inventory_offer_prices_price" CHECK ("price" >= 0),
  CONSTRAINT "inventory_offer_prices_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "inventory_offer_prices_source" CHECK ("source" IN ('invoice', 'website', 'in_store', 'quote', 'manual'))
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_offer_prices_offer_idx" ON "inventory_offer_prices" ("organization_id", "offer_id", "observed_on" DESC);

--> statement-breakpoint

-- ===========================================================================
-- 7. FORMULATIONS, PLANS AND BATCHES
-- ===========================================================================

-- A version of a formulation. Editable as a draft; frozen from the moment it
-- becomes active or retired, so every batch made from it stays reproducible.
-- A new recipe is a new version, never an edit.
CREATE TABLE IF NOT EXISTS "inventory_formulation_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "formulation_id" uuid NOT NULL,
  "label" text NOT NULL,
  "revision_date" date,
  "status" text DEFAULT 'draft' NOT NULL,
  "serving_quantity" numeric(14, 4),
  "serving_unit" text REFERENCES "inventory_units"("code"),
  "default_batch_servings" numeric(12, 2),
  "source_document_id" uuid,
  "notes" text,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_formulation_versions_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_formulation_versions_formulation" FOREIGN KEY ("organization_id", "formulation_id")
    REFERENCES "inventory_formulations" ("organization_id", "id"),
  CONSTRAINT "inventory_formulation_versions_document" FOREIGN KEY ("organization_id", "source_document_id")
    REFERENCES "inventory_documents" ("organization_id", "id"),
  CONSTRAINT "inventory_formulation_versions_label" UNIQUE ("organization_id", "formulation_id", "label"),
  CONSTRAINT "inventory_formulation_versions_status" CHECK ("status" IN ('draft', 'active', 'retired')),
  CONSTRAINT "inventory_formulation_versions_serving" CHECK (("serving_quantity" IS NULL) = ("serving_unit" IS NULL) AND ("serving_quantity" IS NULL OR "serving_quantity" > 0)),
  CONSTRAINT "inventory_formulation_versions_batch" CHECK ("default_batch_servings" IS NULL OR "default_batch_servings" > 0)
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_formulation_versions_one_active"
  ON "inventory_formulation_versions" ("organization_id", "formulation_id") WHERE "status" = 'active';

--> statement-breakpoint

-- One material per serving, and its role: in the dry batch, added separately
-- every time the drink is made, or added only when chosen. Separate additions
-- are real demand on stock but are never inside the batch.
CREATE TABLE IF NOT EXISTS "inventory_formulation_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "version_id" uuid NOT NULL,
  "material_id" uuid NOT NULL,
  "role" text DEFAULT 'batch' NOT NULL,
  "quantity" numeric(18, 8) NOT NULL,
  "unit" text NOT NULL REFERENCES "inventory_units"("code"),
  "preferred_product_id" uuid,
  "position" integer DEFAULT 0 NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_formulation_lines_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_formulation_lines_version" FOREIGN KEY ("organization_id", "version_id")
    REFERENCES "inventory_formulation_versions" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_formulation_lines_material" FOREIGN KEY ("organization_id", "material_id")
    REFERENCES "inventory_materials" ("organization_id", "id"),
  CONSTRAINT "inventory_formulation_lines_product" FOREIGN KEY ("organization_id", "preferred_product_id")
    REFERENCES "inventory_products" ("organization_id", "id"),
  CONSTRAINT "inventory_formulation_lines_once" UNIQUE ("organization_id", "version_id", "material_id", "role"),
  CONSTRAINT "inventory_formulation_lines_role" CHECK ("role" IN ('batch', 'required_addition', 'optional_addition')),
  CONSTRAINT "inventory_formulation_lines_quantity" CHECK ("quantity" > 0)
);

--> statement-breakpoint

CREATE OR REPLACE FUNCTION "inventory_formulation_versions_rules"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Only a draft version can be deleted; retire it instead.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'A version that has left draft cannot be reopened. Make a new version.' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
      RAISE EXCEPTION 'A retired version stays retired. Make a new version.' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.formulation_id, NEW.label, NEW.revision_date, NEW.serving_quantity, NEW.serving_unit)
       IS DISTINCT FROM (OLD.formulation_id, OLD.label, OLD.revision_date, OLD.serving_quantity, OLD.serving_unit) THEN
      RAISE EXCEPTION 'A version is frozen once it leaves draft. Make a new version.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS "inventory_formulation_versions_rules" ON "inventory_formulation_versions";

--> statement-breakpoint

CREATE TRIGGER "inventory_formulation_versions_rules"
  BEFORE UPDATE OR DELETE ON "inventory_formulation_versions"
  FOR EACH ROW
  EXECUTE FUNCTION "inventory_formulation_versions_rules"();

--> statement-breakpoint

CREATE OR REPLACE FUNCTION "inventory_formulation_lines_rules"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  version_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT v.status INTO version_status FROM inventory_formulation_versions v
     WHERE v.organization_id = OLD.organization_id AND v.id = OLD.version_id;
    -- Not found means the version itself is being deleted, which its own rule
    -- already allowed (only drafts can be).
    IF version_status IS NOT NULL AND version_status <> 'draft' THEN
      RAISE EXCEPTION 'The lines of a version are frozen once it leaves draft.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT v.status INTO version_status FROM inventory_formulation_versions v
     WHERE v.organization_id = NEW.organization_id AND v.id = NEW.version_id;
    IF version_status IS NOT NULL AND version_status <> 'draft' THEN
      RAISE EXCEPTION 'The lines of a version are frozen once it leaves draft.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS "inventory_formulation_lines_rules" ON "inventory_formulation_lines";

--> statement-breakpoint

CREATE TRIGGER "inventory_formulation_lines_rules"
  BEFORE INSERT OR UPDATE OR DELETE ON "inventory_formulation_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "inventory_formulation_lines_rules"();

--> statement-breakpoint

-- "I need to make a batch of this, at this scale, by this date." Saving a plan
-- reserves nothing and consumes nothing; it is demand the requirements view
-- counts until a batch is recorded against it.
CREATE TABLE IF NOT EXISTS "inventory_batch_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "version_id" uuid NOT NULL,
  "planned_for" date NOT NULL,
  "servings" numeric(12, 2) NOT NULL,
  "status" text DEFAULT 'planned' NOT NULL,
  "include_optional" boolean DEFAULT false NOT NULL,
  "notes" text,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_batch_plans_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_batch_plans_version" FOREIGN KEY ("organization_id", "version_id")
    REFERENCES "inventory_formulation_versions" ("organization_id", "id"),
  CONSTRAINT "inventory_batch_plans_servings" CHECK ("servings" > 0),
  CONSTRAINT "inventory_batch_plans_status" CHECK ("status" IN ('planned', 'committed', 'made', 'cancelled'))
);

--> statement-breakpoint

-- Stock set aside in a particular container for a particular plan. A reserved
-- amount counts toward that plan's need and is unavailable to every other plan
-- — once, not twice.
CREATE TABLE IF NOT EXISTS "inventory_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "plan_id" uuid NOT NULL,
  "container_id" uuid NOT NULL,
  "material_id" uuid NOT NULL,
  "quantity" numeric(14, 4) NOT NULL,
  "unit" text NOT NULL REFERENCES "inventory_units"("code"),
  "released_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_reservations_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_reservations_plan" FOREIGN KEY ("organization_id", "plan_id")
    REFERENCES "inventory_batch_plans" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_reservations_container" FOREIGN KEY ("organization_id", "container_id")
    REFERENCES "inventory_containers" ("organization_id", "id"),
  CONSTRAINT "inventory_reservations_material" FOREIGN KEY ("organization_id", "material_id")
    REFERENCES "inventory_materials" ("organization_id", "id"),
  CONSTRAINT "inventory_reservations_quantity" CHECK ("quantity" > 0)
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_reservations_once"
  ON "inventory_reservations" ("organization_id", "plan_id", "container_id", "material_id") WHERE "released_at" IS NULL;

--> statement-breakpoint

-- A batch actually made: from which frozen version, for which plan, how much
-- came out and how much was lost. What went in is the ledger's production_use
-- events for this batch; what came out is a lot of the house-blend product.
CREATE TABLE IF NOT EXISTS "inventory_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "version_id" uuid NOT NULL,
  "plan_id" uuid,
  "made_on" date NOT NULL,
  "servings_made" numeric(12, 2),
  "output_g" numeric(12, 3),
  "wastage_g" numeric(12, 3),
  "output_lot_id" uuid,
  "notes" text,
  "made_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_batches_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_batches_version" FOREIGN KEY ("organization_id", "version_id")
    REFERENCES "inventory_formulation_versions" ("organization_id", "id"),
  CONSTRAINT "inventory_batches_plan" FOREIGN KEY ("organization_id", "plan_id")
    REFERENCES "inventory_batch_plans" ("organization_id", "id"),
  CONSTRAINT "inventory_batches_output_lot" FOREIGN KEY ("organization_id", "output_lot_id")
    REFERENCES "inventory_lots" ("organization_id", "id"),
  CONSTRAINT "inventory_batches_amounts" CHECK (
    ("servings_made" IS NULL OR "servings_made" > 0) AND ("output_g" IS NULL OR "output_g" > 0) AND ("wastage_g" IS NULL OR "wastage_g" >= 0)
  )
);

--> statement-breakpoint

CREATE OR REPLACE FUNCTION "inventory_batches_rules"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  version_status text;
BEGIN
  SELECT v.status INTO version_status FROM inventory_formulation_versions v
   WHERE v.organization_id = NEW.organization_id AND v.id = NEW.version_id;
  IF version_status = 'draft' THEN
    RAISE EXCEPTION 'Activate the version before recording a batch made from it, so the record cannot change afterwards.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.plan_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM inventory_batch_plans p
        WHERE p.organization_id = NEW.organization_id AND p.id = NEW.plan_id AND p.version_id = NEW.version_id) THEN
    RAISE EXCEPTION 'A batch is made from the version its plan names.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS "inventory_batches_rules" ON "inventory_batches";

--> statement-breakpoint

CREATE TRIGGER "inventory_batches_rules"
  BEFORE INSERT OR UPDATE OF "version_id", "plan_id" ON "inventory_batches"
  FOR EACH ROW
  EXECUTE FUNCTION "inventory_batches_rules"();

--> statement-breakpoint

-- ===========================================================================
-- 8. THE LEDGER
-- ===========================================================================

-- Every change to what a container holds. ANCHOR events state what is in the
-- container: `opening` (first catalogued, amount possibly unknown), `receipt`
-- (arrived new), `fill` (a new container filled from another), `production_output`
-- (a batch went into it) and `count` (counted or weighed again). CHANGE events
-- add or remove an amount: use in production, adjustment, loss, disposal,
-- transfer in or out, return. A `reversal` voids exactly one earlier event and
-- carries no amount of its own.
--
-- `basis` says how an amount is known: from an unopened package's label, from a
-- weighing (linked), estimated, calculated, or unknown. An opened package's
-- label weight is never an anchor. A counted amount from a weighing must be the
-- weighing's NET, never its gross.
CREATE TABLE IF NOT EXISTS "inventory_movements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "container_id" uuid NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "kind" text NOT NULL,
  "quantity" numeric(14, 4),
  "unit" text REFERENCES "inventory_units"("code"),
  "basis" text,
  "capture_id" uuid,
  "measurement_id" uuid,
  "receipt_line_id" uuid,
  "batch_id" uuid,
  "reverses_id" uuid,
  "idempotency_key" text,
  "recorded_by" uuid REFERENCES "users"("id"),
  "note" text,
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "inventory_movements_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_movements_container" FOREIGN KEY ("organization_id", "container_id")
    REFERENCES "inventory_containers" ("organization_id", "id"),
  CONSTRAINT "inventory_movements_capture" FOREIGN KEY ("organization_id", "capture_id")
    REFERENCES "inventory_captures" ("organization_id", "id"),
  CONSTRAINT "inventory_movements_measurement" FOREIGN KEY ("organization_id", "measurement_id")
    REFERENCES "inventory_measurements" ("organization_id", "id"),
  CONSTRAINT "inventory_movements_receipt_line" FOREIGN KEY ("organization_id", "receipt_line_id")
    REFERENCES "inventory_receipt_lines" ("organization_id", "id"),
  CONSTRAINT "inventory_movements_batch" FOREIGN KEY ("organization_id", "batch_id")
    REFERENCES "inventory_batches" ("organization_id", "id"),
  CONSTRAINT "inventory_movements_reverses" FOREIGN KEY ("organization_id", "reverses_id")
    REFERENCES "inventory_movements" ("organization_id", "id"),
  CONSTRAINT "inventory_movements_idempotency" UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "inventory_movements_reversed_once" UNIQUE ("organization_id", "reverses_id"),
  CONSTRAINT "inventory_movements_kind" CHECK ("kind" IN (
    'opening', 'receipt', 'fill', 'production_output', 'count',
    'production_use', 'adjustment', 'loss', 'disposal', 'transfer_in', 'transfer_out', 'return',
    'reversal')),
  CONSTRAINT "inventory_movements_basis" CHECK ("basis" IS NULL OR "basis" IN ('labelled_unopened', 'measured', 'estimated', 'calculated', 'unknown')),
  CONSTRAINT "inventory_movements_reversal" CHECK (
    ("kind" = 'reversal') = ("reverses_id" IS NOT NULL)
    AND ("kind" <> 'reversal' OR ("quantity" IS NULL AND "basis" IS NULL))
  ),
  CONSTRAINT "inventory_movements_has_basis" CHECK ("kind" = 'reversal' OR "basis" IS NOT NULL),
  CONSTRAINT "inventory_movements_unit_with_amount" CHECK (("quantity" IS NULL) = ("unit" IS NULL)),
  CONSTRAINT "inventory_movements_unknown" CHECK (
    "kind" = 'reversal' OR (("basis" = 'unknown') = ("quantity" IS NULL))
  ),
  CONSTRAINT "inventory_movements_unknown_only_opening" CHECK ("basis" IS DISTINCT FROM 'unknown' OR "kind" = 'opening'),
  CONSTRAINT "inventory_movements_label_only_new" CHECK ("basis" IS DISTINCT FROM 'labelled_unopened' OR "kind" IN ('opening', 'receipt')),
  CONSTRAINT "inventory_movements_measured" CHECK (
    "basis" IS DISTINCT FROM 'measured' OR "kind" NOT IN ('opening', 'count') OR "measurement_id" IS NOT NULL
  ),
  CONSTRAINT "inventory_movements_sign" CHECK (
    "quantity" IS NULL
    OR ("kind" IN ('opening', 'receipt', 'fill', 'production_output', 'transfer_in') AND "quantity" > 0)
    OR ("kind" = 'count' AND "quantity" >= 0)
    OR ("kind" IN ('production_use', 'loss', 'disposal', 'transfer_out', 'return') AND "quantity" < 0)
    OR ("kind" = 'adjustment' AND "quantity" <> 0)
  ),
  CONSTRAINT "inventory_movements_sources" CHECK (
    ("kind" <> 'receipt' OR "receipt_line_id" IS NOT NULL)
    AND ("kind" NOT IN ('production_use', 'production_output') OR "batch_id" IS NOT NULL)
  ),
  CONSTRAINT "inventory_movements_reason" CHECK (
    "kind" NOT IN ('adjustment', 'loss', 'disposal', 'reversal') OR nullif(btrim("note"), '') IS NOT NULL
  )
);

--> statement-breakpoint

-- A container is catalogued once and received once, whatever retries happen.
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_movements_one_opening"
  ON "inventory_movements" ("organization_id", "container_id") WHERE "kind" = 'opening';

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_movements_one_receipt"
  ON "inventory_movements" ("organization_id", "container_id") WHERE "kind" = 'receipt';

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_movements_container_idx"
  ON "inventory_movements" ("organization_id", "container_id", "occurred_at");

--> statement-breakpoint

CREATE OR REPLACE FUNCTION "inventory_movements_rules"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  unit_dimension text;
  unit_size numeric;
  container_dimension text;
  container_status text;
  weighed_container uuid;
  weighed_net numeric;
  capture_container uuid;
  target record;
BEGIN
  SELECT c.dimension, c.status INTO container_dimension, container_status
    FROM inventory_containers c
   WHERE c.organization_id = NEW.organization_id AND c.id = NEW.container_id;
  IF NOT FOUND THEN
    -- Not this business's container. The foreign key refuses it, by name.
    RETURN NEW;
  END IF;

  IF NEW.unit IS NOT NULL THEN
    SELECT u.dimension, u.to_base INTO unit_dimension, unit_size FROM inventory_units u WHERE u.code = NEW.unit;
    IF unit_size IS NULL THEN
      RAISE EXCEPTION 'Stock cannot be recorded in %: it has no fixed size.', NEW.unit
        USING ERRCODE = 'check_violation';
    END IF;
    IF unit_dimension IS DISTINCT FROM container_dimension THEN
      RAISE EXCEPTION 'This container is measured by %, not by %.', container_dimension, unit_dimension
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- An opened package's label says what it held, not what it holds.
  IF NEW.basis = 'labelled_unopened' AND container_status IS DISTINCT FROM 'sealed' THEN
    RAISE EXCEPTION 'An opened package is not still its label weight: weigh it, estimate it, or record it as unknown.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A weighed count is the weighing's net, never its gross.
  IF NEW.measurement_id IS NOT NULL THEN
    SELECT m.container_id, m.net_g INTO weighed_container, weighed_net
      FROM inventory_measurements m
     WHERE m.organization_id = NEW.organization_id AND m.id = NEW.measurement_id;
    IF weighed_container IS DISTINCT FROM NEW.container_id THEN
      RAISE EXCEPTION 'That weighing is of a different container.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind IN ('opening', 'count') AND NEW.basis = 'measured' THEN
      IF weighed_net IS NULL THEN
        RAISE EXCEPTION 'That weighing has no net amount (the tare is unknown), so it cannot state what is inside.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.quantity * unit_size <> weighed_net THEN
        RAISE EXCEPTION 'A weighed amount must be the weighing''s net (% g).', weighed_net
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW.capture_id IS NOT NULL THEN
    SELECT k.container_id INTO capture_container FROM inventory_captures k
     WHERE k.organization_id = NEW.organization_id AND k.id = NEW.capture_id;
    IF capture_container IS DISTINCT FROM NEW.container_id THEN
      RAISE EXCEPTION 'That capture was confirmed as a different container.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.kind = 'reversal' THEN
    SELECT r.container_id, r.kind INTO target FROM inventory_movements r
     WHERE r.organization_id = NEW.organization_id AND r.id = NEW.reverses_id;
    IF target.kind = 'reversal' OR target.container_id IS DISTINCT FROM NEW.container_id THEN
      RAISE EXCEPTION 'A reversal voids one earlier event of the same container.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS "inventory_movements_rules" ON "inventory_movements";

--> statement-breakpoint

CREATE TRIGGER "inventory_movements_rules"
  BEFORE INSERT ON "inventory_movements"
  FOR EACH ROW
  EXECUTE FUNCTION "inventory_movements_rules"();

--> statement-breakpoint

-- ===========================================================================
-- 9. NOTES AND PURCHASES
-- ===========================================================================

-- What this business remembers about a material, product, brand, company or
-- offer — "much stronger aroma from the market vendor", "online orders are
-- slow" — shown again when it matters. A note is a person's experience, not a
-- finding, and belongs to exactly one subject.
CREATE TABLE IF NOT EXISTS "inventory_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "material_id" uuid,
  "product_id" uuid,
  "brand_id" uuid,
  "business_id" uuid,
  "offer_id" uuid,
  "body" text NOT NULL,
  "rating" smallint,
  "noted_on" date DEFAULT CURRENT_DATE NOT NULL,
  "written_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_notes_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_notes_material" FOREIGN KEY ("organization_id", "material_id")
    REFERENCES "inventory_materials" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_notes_product" FOREIGN KEY ("organization_id", "product_id")
    REFERENCES "inventory_products" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_notes_brand" FOREIGN KEY ("organization_id", "brand_id")
    REFERENCES "inventory_brands" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_notes_business" FOREIGN KEY ("organization_id", "business_id")
    REFERENCES "inventory_businesses" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_notes_offer" FOREIGN KEY ("organization_id", "offer_id")
    REFERENCES "inventory_offers" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_notes_one_subject" CHECK (num_nonnulls("material_id", "product_id", "brand_id", "business_id", "offer_id") = 1),
  CONSTRAINT "inventory_notes_body" CHECK (btrim("body") <> ''),
  CONSTRAINT "inventory_notes_rating" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5)
);

--> statement-breakpoint

-- A proposed purchase on its way to a cart and an order. `calculation` keeps
-- the inputs and result that produced the proposal (shortfall, pack size,
-- excess, price and its date) exactly as shown when it was approved.
--
--   proposed -> approved | rejected | cancelled
--   approved -> in_cart | cancelled | failed
--   in_cart  -> ordered | cancelled | failed
--   failed   -> approved (retry, still approved) | cancelled
--
-- A cart is not an order and an order is not a delivery; each is its own state
-- or record.
CREATE TABLE IF NOT EXISTS "inventory_purchase_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "offer_id" uuid NOT NULL,
  "packages" numeric(10, 3) NOT NULL,
  "plan_id" uuid,
  "material_id" uuid,
  "reason" text,
  "calculation" jsonb,
  "status" text DEFAULT 'proposed' NOT NULL,
  "proposed_by" uuid REFERENCES "users"("id"),
  "approved_by" uuid REFERENCES "users"("id"),
  "approved_at" timestamp with time zone,
  "cart_reference" text,
  "carted_at" timestamp with time zone,
  "order_id" uuid,
  "expected_total" numeric(12, 2),
  "currency" char(3) DEFAULT 'CAD' NOT NULL,
  "error" text,
  "idempotency_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_purchase_intents_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "inventory_purchase_intents_offer" FOREIGN KEY ("organization_id", "offer_id")
    REFERENCES "inventory_offers" ("organization_id", "id"),
  CONSTRAINT "inventory_purchase_intents_plan" FOREIGN KEY ("organization_id", "plan_id")
    REFERENCES "inventory_batch_plans" ("organization_id", "id"),
  CONSTRAINT "inventory_purchase_intents_material" FOREIGN KEY ("organization_id", "material_id")
    REFERENCES "inventory_materials" ("organization_id", "id"),
  CONSTRAINT "inventory_purchase_intents_order" FOREIGN KEY ("organization_id", "order_id")
    REFERENCES "inventory_orders" ("organization_id", "id"),
  CONSTRAINT "inventory_purchase_intents_once" UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "inventory_purchase_intents_packages" CHECK ("packages" > 0),
  CONSTRAINT "inventory_purchase_intents_total" CHECK ("expected_total" IS NULL OR "expected_total" >= 0),
  CONSTRAINT "inventory_purchase_intents_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "inventory_purchase_intents_status" CHECK ("status" IN ('proposed', 'approved', 'in_cart', 'ordered', 'rejected', 'cancelled', 'failed')),
  CONSTRAINT "inventory_purchase_intents_approved" CHECK (
    "status" IN ('proposed', 'rejected', 'cancelled') OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL)
  ),
  CONSTRAINT "inventory_purchase_intents_carted" CHECK ("status" NOT IN ('in_cart', 'ordered') OR "carted_at" IS NOT NULL),
  CONSTRAINT "inventory_purchase_intents_ordered" CHECK ("status" <> 'ordered' OR "order_id" IS NOT NULL)
);

--> statement-breakpoint

-- Approval by a person of this business, transitions in order, and every change
-- of state written to the platform's audit log.
CREATE OR REPLACE FUNCTION "inventory_purchase_intents_rules"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.approved_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    IF NOT EXISTS (
      SELECT 1 FROM users u
        JOIN memberships m ON m.user_id = u.id AND m.organization_id = NEW.organization_id
       WHERE u.id = NEW.approved_by AND NOT u.is_service AND u.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'A purchase is approved by a person who belongs to this business.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('proposed', 'approved') THEN
      RAISE EXCEPTION 'A purchase starts as proposed or approved, not %.', NEW.status USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'proposed' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
      OR (OLD.status = 'approved' AND NEW.status IN ('in_cart', 'cancelled', 'failed'))
      OR (OLD.status = 'in_cart' AND NEW.status IN ('ordered', 'cancelled', 'failed'))
      OR (OLD.status = 'failed' AND NEW.status IN ('approved', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'A purchase cannot go from % to %.', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO audit_events (organization_id, actor_user_id, action, target)
    VALUES (
      NEW.organization_id,
      coalesce(NULLIF(current_setting('app.user_id', true), '')::uuid, NEW.approved_by, NEW.proposed_by),
      'inventory.purchase.' || NEW.status,
      'inventory_purchase_intents:' || NEW.id::text
    );
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS "inventory_purchase_intents_rules" ON "inventory_purchase_intents";

--> statement-breakpoint

CREATE TRIGGER "inventory_purchase_intents_rules"
  BEFORE INSERT OR UPDATE ON "inventory_purchase_intents"
  FOR EACH ROW
  EXECUTE FUNCTION "inventory_purchase_intents_rules"();

--> statement-breakpoint

-- A preference names a vendor, and optionally one of its offers or one product;
-- whatever it names must be able to supply the material. Ranking an
-- alternative is a choice of seller, never a silent change of product, extract
-- or potency.
CREATE OR REPLACE FUNCTION "inventory_sourcing_preferences_rules"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  offer_vendor uuid;
  offer_product uuid;
  supplied_product uuid;
BEGIN
  IF NEW.offer_id IS NOT NULL THEN
    SELECT o.vendor_id, o.product_id INTO offer_vendor, offer_product FROM inventory_offers o
     WHERE o.organization_id = NEW.organization_id AND o.id = NEW.offer_id;
    IF offer_vendor IS DISTINCT FROM NEW.vendor_id THEN
      RAISE EXCEPTION 'That offer belongs to a different vendor.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.product_id IS NOT NULL AND offer_product IS DISTINCT FROM NEW.product_id THEN
      RAISE EXCEPTION 'That offer is for a different product.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  supplied_product := coalesce(NEW.product_id, offer_product);
  IF NEW.material_id IS NOT NULL AND supplied_product IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM inventory_product_components pc
        WHERE pc.organization_id = NEW.organization_id AND pc.product_id = supplied_product AND pc.material_id = NEW.material_id) THEN
    RAISE EXCEPTION 'That product is not recorded as containing this material.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS "inventory_sourcing_preferences_rules" ON "inventory_sourcing_preferences";

--> statement-breakpoint

CREATE TRIGGER "inventory_sourcing_preferences_rules"
  BEFORE INSERT OR UPDATE ON "inventory_sourcing_preferences"
  FOR EACH ROW
  EXECUTE FUNCTION "inventory_sourcing_preferences_rules"();

--> statement-breakpoint

-- ===========================================================================
-- 10. VIEWS
--
-- Every view runs with the CALLER's rights (security_invoker), so the tenant
-- policies on the tables underneath apply to it. A view without this option
-- runs as its owner, and the owner is exempt from row-level security: it would
-- quietly show every business's stock to anyone allowed to read the view.
-- ===========================================================================

-- The companies this business deals with, by name and live iD.
CREATE OR REPLACE VIEW "inventory_business_directory" WITH (security_invoker = true) AS
SELECT b.organization_id,
       b.id AS business_id,
       b.company_id,
       o.name,
       o.type::text AS company_type,
       i.id_code,
       b.is_vendor,
       b.is_supplier,
       b.is_manufacturer,
       b.is_brand_owner,
       b.status
  FROM inventory_businesses b
  JOIN organizations o ON o.id = b.company_id
  LEFT JOIN identities i ON i.organization_id = b.company_id AND i.revoked_at IS NULL;

--> statement-breakpoint

-- What each container holds now, in its base unit (g, ml or items), and how
-- that is known. A balance is the latest anchor plus the changes recorded
-- after it; voided events and their reversals are ignored. With no anchor, or
-- an anchor whose amount is unknown, the balance is NULL and `balance_basis` is
-- 'unknown' — never zero.
CREATE OR REPLACE VIEW "inventory_container_balances" WITH (security_invoker = true) AS
WITH live AS (
  SELECT m.organization_id, m.container_id, m.id, m.kind, m.basis, m.occurred_at, m.created_at,
         m.quantity * u.to_base AS qty
    FROM inventory_movements m
    LEFT JOIN inventory_units u ON u.code = m.unit
   WHERE m.kind <> 'reversal'
     AND NOT EXISTS (
       SELECT 1 FROM inventory_movements r
        WHERE r.organization_id = m.organization_id AND r.reverses_id = m.id)
),
anchor AS (
  SELECT DISTINCT ON (organization_id, container_id)
         organization_id, container_id, id, basis, occurred_at, created_at, qty
    FROM live
   WHERE kind IN ('opening', 'receipt', 'fill', 'production_output', 'count')
   ORDER BY organization_id, container_id, occurred_at DESC, created_at DESC, id DESC
),
since AS (
  SELECT a.organization_id, a.container_id,
         sum(l.qty) AS delta,
         bool_or(l.basis = 'estimated') AS any_estimated
    FROM anchor a
    JOIN live l ON l.organization_id = a.organization_id AND l.container_id = a.container_id
   WHERE l.kind NOT IN ('opening', 'receipt', 'fill', 'production_output', 'count')
     AND (l.occurred_at, l.created_at, l.id) > (a.occurred_at, a.created_at, a.id)
   GROUP BY a.organization_id, a.container_id
)
SELECT c.organization_id,
       c.id AS container_id,
       c.code,
       c.status,
       c.dimension,
       CASE c.dimension WHEN 'mass' THEN 'g' WHEN 'volume' THEN 'ml' ELSE 'count' END AS base_unit,
       c.location_id,
       c.lot_id,
       l.product_id,
       l.lot_code,
       l.expiry_kind,
       l.expiry_date,
       l.acquired_on,
       l.hold,
       c.nominal_quantity,
       c.nominal_unit,
       (a.qty + coalesce(s.delta, 0))::numeric(18, 4) AS balance,
       CASE
         WHEN a.id IS NULL OR a.qty IS NULL THEN 'unknown'
         WHEN a.basis = 'estimated' OR coalesce(s.any_estimated, false) THEN 'estimated'
         ELSE a.basis
       END AS balance_basis,
       a.occurred_at AS balance_as_of
  FROM inventory_containers c
  JOIN inventory_lots l ON l.organization_id = c.organization_id AND l.id = c.lot_id
  LEFT JOIN anchor a ON a.organization_id = c.organization_id AND a.container_id = c.id
  LEFT JOIN since s ON s.organization_id = c.organization_id AND s.container_id = c.id;

--> statement-breakpoint

-- Each order line against what has arrived: a partial delivery leaves the rest
-- outstanding, and only what arrived is stock.
CREATE OR REPLACE VIEW "inventory_order_line_status" WITH (security_invoker = true) AS
SELECT ol.organization_id,
       ol.order_id,
       ol.id AS order_line_id,
       ol.product_id,
       ol.packages AS packages_ordered,
       coalesce(sum(rl.packages_accepted), 0)::numeric(10, 3) AS packages_received,
       coalesce(sum(rl.packages_rejected), 0)::numeric(10, 3) AS packages_rejected,
       greatest(ol.packages - coalesce(sum(rl.packages_accepted), 0), 0)::numeric(10, 3) AS packages_outstanding,
       ol.package_quantity,
       ol.package_unit,
       (greatest(ol.packages - coalesce(sum(rl.packages_accepted), 0), 0) * ol.package_quantity)::numeric(18, 4) AS quantity_outstanding
  FROM inventory_order_lines ol
  LEFT JOIN inventory_receipt_lines rl ON rl.organization_id = ol.organization_id AND rl.order_line_id = ol.id
 GROUP BY ol.organization_id, ol.order_id, ol.id, ol.product_id, ol.packages, ol.package_quantity, ol.package_unit;

--> statement-breakpoint

-- What each open plan needs of each material by its date, and the shortfall.
--
--   * Demand: every open plan (planned or committed, with no batch recorded
--     yet), each counted once, including separate additions it requires and,
--     if the plan says so, its optional ones.
--   * A plan's own reservations count toward its need; every reservation is
--     unavailable to the other plans. Once, not twice.
--   * Usable stock: containers that are sealed or open, not on hold, with a
--     KNOWN balance, not expired by the plan's date, of products whose
--     composition states an amount of the material. Containers of unknown
--     balance are reported as `containers_to_verify`, never counted as supply.
--   * Incoming: outstanding order quantities expected ON OR BEFORE the plan's
--     date. A late order, or one with no expected date, does not count.
--   * Plans are taken in date order. `shortfall` is what THIS plan adds to the
--     total missing by its date.
CREATE OR REPLACE VIEW "inventory_plan_requirements" WITH (security_invoker = true) AS
WITH open_plans AS (
  SELECT p.organization_id, p.id, p.version_id, p.planned_for, p.servings, p.include_optional, p.status
    FROM inventory_batch_plans p
   WHERE p.status IN ('planned', 'committed')
     AND NOT EXISTS (
       SELECT 1 FROM inventory_batches b WHERE b.organization_id = p.organization_id AND b.plan_id = p.id)
),
demand AS (
  SELECT p.organization_id, p.id AS plan_id, p.planned_for, p.status AS plan_status, l.material_id, mat.dimension,
         sum(p.servings * l.quantity * u.to_base) AS required
    FROM open_plans p
    JOIN inventory_formulation_lines l ON l.organization_id = p.organization_id AND l.version_id = p.version_id
    JOIN inventory_materials mat ON mat.organization_id = l.organization_id AND mat.id = l.material_id
    JOIN inventory_units u ON u.code = l.unit AND u.dimension = mat.dimension
   WHERE l.role <> 'optional_addition' OR p.include_optional
   GROUP BY p.organization_id, p.id, p.planned_for, p.status, l.material_id, mat.dimension
),
reserved AS (
  SELECT r.organization_id, r.plan_id, r.container_id, r.material_id, sum(r.quantity * u.to_base) AS qty
    FROM inventory_reservations r
    JOIN inventory_units u ON u.code = r.unit
    JOIN open_plans p ON p.organization_id = r.organization_id AND p.id = r.plan_id
   WHERE r.released_at IS NULL
   GROUP BY r.organization_id, r.plan_id, r.container_id, r.material_id
),
held AS (
  SELECT b.organization_id, b.container_id, pc.material_id, b.expiry_date,
         b.balance * (pc.quantity * cu.to_base) / (pc.per_quantity * pu.to_base) AS qty
    FROM inventory_container_balances b
    JOIN inventory_product_components pc ON pc.organization_id = b.organization_id AND pc.product_id = b.product_id
    JOIN inventory_materials mat ON mat.organization_id = pc.organization_id AND mat.id = pc.material_id
    JOIN inventory_units cu ON cu.code = pc.unit AND cu.dimension = mat.dimension
    JOIN inventory_units pu ON pu.code = pc.per_unit AND pu.dimension = b.dimension
   WHERE b.status IN ('sealed', 'open') AND b.hold = 'none'
),
unreserved AS (
  SELECT h.organization_id, h.material_id, h.expiry_date,
         greatest(h.qty - coalesce(sum(r.qty), 0), 0) AS qty
    FROM held h
    LEFT JOIN reserved r ON r.organization_id = h.organization_id AND r.container_id = h.container_id AND r.material_id = h.material_id
   WHERE h.qty IS NOT NULL
   GROUP BY h.organization_id, h.container_id, h.material_id, h.expiry_date, h.qty
),
unknown_containers AS (
  SELECT organization_id, material_id, count(*) AS n
    FROM held
   WHERE qty IS NULL
   GROUP BY organization_id, material_id
),
incoming AS (
  SELECT ol.organization_id, pc.material_id, o.expected_on,
         sum(s.packages_outstanding * ol.package_quantity * pku.to_base
             * (pc.quantity * cu.to_base) / (pc.per_quantity * pu.to_base)) AS qty
    FROM inventory_order_line_status s
    JOIN inventory_order_lines ol ON ol.organization_id = s.organization_id AND ol.id = s.order_line_id
    JOIN inventory_orders o ON o.organization_id = ol.organization_id AND o.id = ol.order_id
    JOIN inventory_units pku ON pku.code = ol.package_unit
    JOIN inventory_product_components pc ON pc.organization_id = ol.organization_id AND pc.product_id = ol.product_id
    JOIN inventory_materials mat ON mat.organization_id = pc.organization_id AND mat.id = pc.material_id
    JOIN inventory_units cu ON cu.code = pc.unit AND cu.dimension = mat.dimension
    JOIN inventory_units pu ON pu.code = pc.per_unit AND pu.dimension = pku.dimension
   WHERE o.status IN ('placed', 'partially_received')
     AND o.expected_on IS NOT NULL
     AND s.packages_outstanding > 0
   GROUP BY ol.organization_id, pc.material_id, o.expected_on
),
needs AS (
  SELECT d.*,
         coalesce(rp.qty, 0) AS reserved_for_plan,
         greatest(d.required - coalesce(rp.qty, 0), 0) AS net_required
    FROM demand d
    LEFT JOIN (
      SELECT organization_id, plan_id, material_id, sum(qty) AS qty FROM reserved GROUP BY 1, 2, 3
    ) rp ON rp.organization_id = d.organization_id AND rp.plan_id = d.plan_id AND rp.material_id = d.material_id
),
ordered AS (
  SELECT n.*,
         sum(n.net_required) OVER (
           PARTITION BY n.organization_id, n.material_id
           ORDER BY n.planned_for, n.plan_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative
    FROM needs n
),
supplied AS (
  SELECT o.*,
         coalesce(st.qty, 0) AS usable_stock,
         coalesce(inc.qty, 0) AS arriving_in_time
    FROM ordered o
    LEFT JOIN LATERAL (
      SELECT sum(u.qty) AS qty FROM unreserved u
       WHERE u.organization_id = o.organization_id AND u.material_id = o.material_id
         AND (u.expiry_date IS NULL OR u.expiry_date >= o.planned_for)
    ) st ON true
    LEFT JOIN LATERAL (
      SELECT sum(i.qty) AS qty FROM incoming i
       WHERE i.organization_id = o.organization_id AND i.material_id = o.material_id
         AND i.expected_on <= o.planned_for
    ) inc ON true
)
SELECT s.organization_id,
       s.plan_id,
       s.planned_for,
       s.plan_status,
       s.material_id,
       s.dimension,
       CASE s.dimension WHEN 'mass' THEN 'g' WHEN 'volume' THEN 'ml' ELSE 'count' END AS base_unit,
       s.required::numeric(18, 4) AS required,
       s.reserved_for_plan::numeric(18, 4) AS reserved_for_plan,
       s.usable_stock::numeric(18, 4) AS usable_stock,
       s.arriving_in_time::numeric(18, 4) AS arriving_in_time,
       (s.cumulative - s.net_required)::numeric(18, 4) AS needed_first_by_earlier_plans,
       (greatest(0, s.cumulative - s.usable_stock - s.arriving_in_time)
        - greatest(0, s.cumulative - s.net_required - s.usable_stock - s.arriving_in_time))::numeric(18, 4) AS shortfall,
       coalesce(uc.n, 0) AS containers_to_verify
  FROM supplied s
  LEFT JOIN unknown_containers uc ON uc.organization_id = s.organization_id AND uc.material_id = s.material_id;

--> statement-breakpoint

-- Every ranked way to buy each shortfall, in whole packages: how many, how much
-- that buys, the excess, and the dated price and stock status it rests on.
-- `recommended` marks the best-ranked offer currently showing stock; an offer
-- whose stock was never checked is listed but never recommended.
CREATE OR REPLACE VIEW "inventory_purchase_options" WITH (security_invoker = true) AS
WITH options AS (
  SELECT r.organization_id, r.plan_id, r.planned_for, r.material_id, r.base_unit, r.shortfall,
         p.rank, p.vendor_id, o.id AS offer_id, o.product_id,
         o.package_quantity, o.package_unit,
         o.package_quantity * pku.to_base * (pc.quantity * cu.to_base) / (pc.per_quantity * pu.to_base) AS per_package,
         o.price, o.currency, o.price_checked_at, o.stock_status, o.stock_checked_at,
         o.lead_time_days, o.lead_time_basis
    FROM inventory_plan_requirements r
    JOIN inventory_sourcing_preferences p
      ON p.organization_id = r.organization_id AND p.material_id = r.material_id AND p.active
    JOIN inventory_offers o
      ON o.organization_id = p.organization_id AND o.vendor_id = p.vendor_id AND o.archived_at IS NULL
     AND (p.offer_id IS NULL OR o.id = p.offer_id)
     AND (p.product_id IS NULL OR o.product_id = p.product_id)
    JOIN inventory_units pku ON pku.code = o.package_unit
    JOIN inventory_product_components pc
      ON pc.organization_id = o.organization_id AND pc.product_id = o.product_id AND pc.material_id = r.material_id
    JOIN inventory_materials mat ON mat.organization_id = pc.organization_id AND mat.id = pc.material_id
    JOIN inventory_units cu ON cu.code = pc.unit AND cu.dimension = mat.dimension
    JOIN inventory_units pu ON pu.code = pc.per_unit AND pu.dimension = pku.dimension
   WHERE r.shortfall > 0
),
sized AS (
  SELECT x.*,
         ceil(x.shortfall / x.per_package) AS packages,
         x.stock_status IN ('in_stock', 'low_stock') AS available
    FROM options x
   WHERE x.per_package > 0
)
SELECT z.organization_id,
       z.plan_id,
       z.planned_for,
       z.material_id,
       z.base_unit,
       z.shortfall,
       z.rank,
       z.vendor_id,
       z.offer_id,
       z.product_id,
       z.package_quantity,
       z.package_unit,
       z.per_package::numeric(18, 4) AS per_package,
       z.packages::numeric(10, 0) AS packages,
       (z.packages * z.per_package)::numeric(18, 4) AS purchased,
       (z.packages * z.per_package - z.shortfall)::numeric(18, 4) AS excess,
       z.price,
       z.currency,
       (z.packages * z.price)::numeric(12, 2) AS estimated_cost,
       z.price_checked_at,
       z.stock_status,
       z.stock_checked_at,
       z.lead_time_days,
       z.lead_time_basis,
       z.available,
       (z.available AND row_number() OVER (
          PARTITION BY z.organization_id, z.plan_id, z.material_id
          ORDER BY z.available DESC, z.rank, z.price NULLS LAST, z.offer_id) = 1) AS recommended
  FROM sized z;

--> statement-breakpoint

-- ===========================================================================
-- 11. ACCESS
-- ===========================================================================

GRANT SELECT ON "inventory_units" TO portal_app;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "inventory_nutrients", "inventory_materials", "inventory_material_aliases", "inventory_businesses",
  "inventory_brands", "inventory_formulations", "inventory_products", "inventory_product_components",
  "inventory_offers", "inventory_sourcing_preferences", "inventory_orders", "inventory_order_lines",
  "inventory_receipts", "inventory_receipt_lines", "inventory_locations", "inventory_lots",
  "inventory_containers", "inventory_captures", "inventory_documents", "inventory_document_links",
  "inventory_extractions", "inventory_extracted_fields", "inventory_match_candidates", "inventory_measurements",
  "inventory_product_nutrients", "inventory_product_claims", "inventory_offer_prices",
  "inventory_formulation_versions", "inventory_formulation_lines", "inventory_batch_plans",
  "inventory_reservations", "inventory_batches", "inventory_notes", "inventory_purchase_intents"
TO portal_app;

--> statement-breakpoint

-- The ledger is append-only for the application: no UPDATE, no DELETE. A
-- mistake is voided by a reversal, so the history of what was believed and
-- when is never lost.
GRANT SELECT, INSERT ON "inventory_movements" TO portal_app;

--> statement-breakpoint

GRANT SELECT ON
  "inventory_business_directory", "inventory_container_balances", "inventory_order_line_status",
  "inventory_plan_requirements", "inventory_purchase_options"
TO portal_app;

--> statement-breakpoint

-- Tenant isolation on every inventory table, exactly as 0001 defines it: an
-- unscoped connection sees nothing, and a row can only be written into the
-- business currently in scope. No staff policy, on purpose.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'inventory_nutrients', 'inventory_materials', 'inventory_material_aliases', 'inventory_businesses',
    'inventory_brands', 'inventory_formulations', 'inventory_products', 'inventory_product_components',
    'inventory_offers', 'inventory_sourcing_preferences', 'inventory_orders', 'inventory_order_lines',
    'inventory_receipts', 'inventory_receipt_lines', 'inventory_locations', 'inventory_lots',
    'inventory_containers', 'inventory_captures', 'inventory_documents', 'inventory_document_links',
    'inventory_extractions', 'inventory_extracted_fields', 'inventory_match_candidates', 'inventory_measurements',
    'inventory_product_nutrients', 'inventory_product_claims', 'inventory_offer_prices',
    'inventory_formulation_versions', 'inventory_formulation_lines', 'inventory_batch_plans',
    'inventory_reservations', 'inventory_batches', 'inventory_movements', 'inventory_notes',
    'inventory_purchase_intents'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO portal_app '
      || 'USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) '
      || 'WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;
