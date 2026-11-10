-- Use book-local records for private intake. A contact never needs an account
-- or a listed organization. Preserve existing IDs used by saved Work Decks.
CREATE TABLE public.address_book_entries (
  book_kind text NOT NULL CHECK (book_kind IN ('personal', 'company')),
  book_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('person', 'company')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  company_name text NOT NULL DEFAULT '' CHECK (length(company_name) <= 200),
  email text NOT NULL DEFAULT '' CHECK (length(email) <= 254),
  phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 80),
  company_id uuid,
  roles text[] NOT NULL DEFAULT '{}',
  details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  source text NOT NULL CHECK (source IN ('legacy', 'manual', 'outlook', 'brand-import')),
  source_key text,
  source_brand text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (book_kind, book_id, id),
  FOREIGN KEY (book_kind, book_id, company_id)
    REFERENCES public.address_book_entries (book_kind, book_id, id),
  CHECK (company_id IS NULL OR (kind = 'person' AND company_id <> id)),
  CHECK (CASE kind
    WHEN 'person' THEN roles <@ ARRAY['Main Contact', 'Billing', 'Approvals']
    ELSE roles <@ ARRAY['Client', 'Supplier', 'Partner']
  END)
);
--> statement-breakpoint
CREATE INDEX address_book_entries_by_name ON public.address_book_entries
  (book_kind, book_id, lower(name), id);
--> statement-breakpoint
CREATE UNIQUE INDEX address_book_import_retries ON public.address_book_entries
  (book_kind, book_id, source_key) WHERE source_key IS NOT NULL;
--> statement-breakpoint
INSERT INTO public.address_book_entries
  (book_kind, book_id, id, kind, name, email, phone, details, source)
SELECT 'company', organization_id, person_id, 'person', display_name,
  left(coalesce(fingerprint->>'email', ''), 254), left(coalesce(fingerprint->>'phone', ''), 80),
  fingerprint, 'legacy'
FROM directory_people;
--> statement-breakpoint
INSERT INTO public.address_book_entries
  (book_kind, book_id, id, kind, name, email, phone, details, source)
SELECT 'company', d.organization_id, d.company_id, 'company',
  coalesce(nullif(left(btrim(o.name), 200), ''), 'Company'),
  left(coalesce(d.fingerprint->>'email', ''), 254), left(coalesce(d.fingerprint->>'phone', ''), 80),
  d.fingerprint, 'legacy'
FROM directory_companies d
JOIN organizations o ON o.id = d.company_id
WHERE o.deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE public.address_book_deck_contacts (
  book_kind text GENERATED ALWAYS AS ('company'::text) STORED,
  book_id uuid NOT NULL,
  deck_ref text NOT NULL,
  person_id uuid NOT NULL,
  company_id uuid,
  PRIMARY KEY (book_id, deck_ref),
  FOREIGN KEY (book_kind, book_id, person_id)
    REFERENCES public.address_book_entries (book_kind, book_id, id),
  FOREIGN KEY (book_kind, book_id, company_id)
    REFERENCES public.address_book_entries (book_kind, book_id, id)
);
--> statement-breakpoint
INSERT INTO public.address_book_deck_contacts (book_id, deck_ref, person_id, company_id)
SELECT d.organization_id, d.deck_ref, d.person_id, c.id
FROM work_deck_contacts d
JOIN public.address_book_entries p
  ON p.book_kind = 'company' AND p.book_id = d.organization_id AND p.id = d.person_id
LEFT JOIN public.address_book_entries c
  ON c.book_kind = 'company' AND c.book_id = d.organization_id AND c.id = d.company_id;
--> statement-breakpoint
ALTER TABLE public.address_book_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY address_book_scope ON public.address_book_entries TO portal_app USING (
  (book_kind = 'personal' AND book_id = nullif(current_setting('app.user_id', true), '')::uuid)
  OR (book_kind = 'company' AND book_id = nullif(current_setting('app.org_id', true), '')::uuid)
);
--> statement-breakpoint
ALTER TABLE public.address_book_deck_contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY address_book_deck_scope ON public.address_book_deck_contacts TO portal_app USING (
  book_id = nullif(current_setting('app.org_id', true), '')::uuid
);
--> statement-breakpoint
GRANT SELECT, INSERT ON public.address_book_entries, public.address_book_deck_contacts TO portal_app;
--> statement-breakpoint
GRANT UPDATE (name, company_name, email, phone, company_id, roles, revision)
  ON public.address_book_entries TO portal_app;
--> statement-breakpoint
GRANT UPDATE (person_id, company_id) ON public.address_book_deck_contacts TO portal_app;
--> statement-breakpoint
-- The previous UI can still be serving requests while the migration is live.
-- Preserve legacy contacts and sample-job assignments created during that window.
CREATE FUNCTION public.capture_legacy_address_book_write() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_TABLE_NAME = 'directory_people' THEN
    INSERT INTO public.address_book_entries
      (book_kind, book_id, id, kind, name, email, phone, details, source)
    VALUES ('company', NEW.organization_id, NEW.person_id, 'person', NEW.display_name,
      left(coalesce(NEW.fingerprint->>'email', ''), 254),
      left(coalesce(NEW.fingerprint->>'phone', ''), 80), NEW.fingerprint, 'legacy')
    ON CONFLICT DO NOTHING;
  ELSIF TG_TABLE_NAME = 'directory_companies' THEN
    INSERT INTO public.address_book_entries
      (book_kind, book_id, id, kind, name, email, phone, details, source)
    SELECT 'company', NEW.organization_id, NEW.company_id, 'company',
      coalesce(nullif(left(btrim(o.name), 200), ''), 'Company'),
      left(coalesce(NEW.fingerprint->>'email', ''), 254),
      left(coalesce(NEW.fingerprint->>'phone', ''), 80), NEW.fingerprint, 'legacy'
    FROM organizations o WHERE o.id = NEW.company_id AND o.deleted_at IS NULL
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public.address_book_deck_contacts (book_id, deck_ref, person_id, company_id)
    SELECT NEW.organization_id, NEW.deck_ref, NEW.person_id, c.id
    FROM public.address_book_entries p
    LEFT JOIN public.address_book_entries c
      ON c.book_kind = 'company' AND c.book_id = NEW.organization_id AND c.id = NEW.company_id
    WHERE p.book_kind = 'company' AND p.book_id = NEW.organization_id AND p.id = NEW.person_id
    ON CONFLICT (book_id, deck_ref) DO UPDATE
      SET person_id = excluded.person_id, company_id = excluded.company_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.capture_legacy_address_book_write() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER capture_legacy_people AFTER INSERT ON directory_people
FOR EACH ROW EXECUTE FUNCTION public.capture_legacy_address_book_write();
--> statement-breakpoint
CREATE TRIGGER capture_legacy_companies AFTER INSERT ON directory_companies
FOR EACH ROW EXECUTE FUNCTION public.capture_legacy_address_book_write();
--> statement-breakpoint
CREATE TRIGGER capture_legacy_deck_links AFTER INSERT OR UPDATE ON work_deck_contacts
FOR EACH ROW EXECUTE FUNCTION public.capture_legacy_address_book_write();
