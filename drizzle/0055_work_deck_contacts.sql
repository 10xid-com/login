-- Permanent person keys carry no private contact data. A person need not have
-- an account. Account association is an operator-verified operation only.
CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid UNIQUE REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE directory_people (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL REFERENCES people(id),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
  fingerprint jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(fingerprint) = 'object'),
  PRIMARY KEY (organization_id, person_id)
);
--> statement-breakpoint
CREATE INDEX directory_person_lookup ON directory_people (organization_id, lower(display_name));
--> statement-breakpoint
CREATE TABLE directory_companies (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  company_id uuid NOT NULL REFERENCES organizations(id),
  fingerprint jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(fingerprint) = 'object'),
  PRIMARY KEY (organization_id, company_id)
);
--> statement-breakpoint
CREATE TABLE work_deck_contacts (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  deck_ref text NOT NULL CHECK (length(trim(deck_ref)) BETWEEN 1 AND 100),
  person_id uuid NOT NULL,
  company_id uuid,
  PRIMARY KEY (organization_id, deck_ref),
  FOREIGN KEY (organization_id, person_id) REFERENCES directory_people(organization_id, person_id),
  FOREIGN KEY (organization_id, company_id) REFERENCES directory_companies(organization_id, company_id)
);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['directory_people','directory_companies','work_deck_contacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY directory_scope ON %I TO portal_app USING (organization_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON people FROM PUBLIC, portal_app;
--> statement-breakpoint
GRANT INSERT (id) ON people TO portal_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON directory_people, directory_companies, work_deck_contacts TO portal_app;
--> statement-breakpoint
GRANT UPDATE (display_name, fingerprint) ON directory_people TO portal_app;
--> statement-breakpoint
GRANT UPDATE (fingerprint) ON directory_companies TO portal_app;
--> statement-breakpoint
GRANT UPDATE (person_id, company_id) ON work_deck_contacts TO portal_app;
