-- 0030: Vinyl Wrap Toronto's website moves from Branding Centres to Vinyl Wrap Toronto.
--
-- WHY. The Website channel's connection to Vinyl Wrap Toronto's site (and the
-- GitHub repository it was connected with) was made while Branding Centres was
-- the business open in the portal, so both rows belong to Branding Centres.
-- They are Vinyl Wrap Toronto's. Paolo's decision of 2026-10-09: move them.
--
-- HOW. Nothing is re-pointed in place. Branding Centres' past Chat Boss
-- conversations and runs name that repository by (id, organization_id), so
-- changing the repository row's business would break them. Instead, the way
-- the portal itself does it by hand:
--   1. Branding Centres' website connection is DISCONNECTED (disconnected_at);
--      if it had a repository, that repository is UNLINKED (unlinked_at). Both
--      rows stay, so Branding Centres' history still reads.
--   2. Vinyl Wrap Toronto gets the same repository LINKED (a new row: same
--      installation, GitHub id, owner, name and default branch, linked by the
--      person who linked it before) and the same site CONNECTED to it (a new
--      row: same address, connected by the person who connected it before).
--   3. Each step is recorded in the audit log of the business it happened to.
--
-- Only a live connection whose address is a Vinyl Wrap Toronto address
-- (vinylwraptoronto.com or a subdomain of it) is moved: nothing else Branding
-- Centres has connected is touched.
--
-- SKIPS, never raises (an exception would fail the pre-deploy step and take
-- the whole deploy down): no such business, nothing to move, or Vinyl Wrap
-- Toronto already has a live website connection. IDEMPOTENT: once moved,
-- Branding Centres has nothing left to move.
--
-- THE LOG IS THE ONLY READ PATH. Notices reach the deploy log through the
-- `notice` listener in scripts/migrate.mjs.

DO $$
DECLARE
  v_bc        uuid;
  v_vwt       uuid;
  v_site      site_connections%ROWTYPE;
  v_repo      repositories%ROWTYPE;
  v_new_repo  uuid;
  v_existing  text;
BEGIN
  RAISE NOTICE '[vwt-site] ======== website: branding-centres -> vinyl-wrap-toronto ========';

  SELECT o.id INTO v_bc FROM organizations o WHERE o.slug = 'branding-centres' AND o.deleted_at IS NULL;
  SELECT o.id INTO v_vwt
    FROM organizations o
   WHERE o.slug = 'vinyl-wrap-toronto' AND o.type = 'client' AND o.deleted_at IS NULL;
  IF v_bc IS NULL OR v_vwt IS NULL THEN
    RAISE NOTICE '[vwt-site] SKIPPED — branding-centres or vinyl-wrap-toronto not found. Nothing written.';
    RETURN;
  END IF;

  SELECT * INTO v_site
    FROM site_connections s
   WHERE s.organization_id = v_bc
     AND s.channel = 'website'
     AND s.disconnected_at IS NULL
     AND s.site_url ~ '^https://([a-z0-9-]+\.)*vinylwraptoronto\.com$';
  IF v_site.id IS NULL THEN
    RAISE NOTICE '[vwt-site] nothing to move — Branding Centres has no live Vinyl Wrap Toronto website connection. Nothing written.';
    RETURN;
  END IF;
  RAISE NOTICE '[vwt-site] found  % on branding-centres (repository %)', v_site.site_url, coalesce(v_site.repository_id::text, 'none');

  SELECT s.site_url INTO v_existing
    FROM site_connections s
   WHERE s.organization_id = v_vwt AND s.channel = 'website' AND s.disconnected_at IS NULL;
  IF v_existing IS NOT NULL THEN
    RAISE NOTICE '[vwt-site] SKIPPED — vinyl-wrap-toronto already has a live website connection (%). Nothing written.', v_existing;
    RETURN;
  END IF;

  -- 1. Off Branding Centres.
  UPDATE site_connections SET disconnected_at = now() WHERE id = v_site.id;
  INSERT INTO audit_events (organization_id, actor_user_id, action, target)
  VALUES (v_bc, NULL, 'site.disconnected', v_site.site_url || ' (moved to Vinyl Wrap Toronto, migration 0030)');

  IF v_site.repository_id IS NOT NULL THEN
    SELECT * INTO v_repo FROM repositories r WHERE r.id = v_site.repository_id AND r.unlinked_at IS NULL;
  END IF;

  IF v_repo.id IS NOT NULL THEN
    UPDATE repositories SET unlinked_at = now() WHERE id = v_repo.id;
    INSERT INTO audit_events (organization_id, actor_user_id, action, target)
    VALUES (v_bc, NULL, 'repository.unlinked', v_repo.owner || '/' || v_repo.name || ' (moved to Vinyl Wrap Toronto, migration 0030)');

    -- 2. Onto Vinyl Wrap Toronto: the repository first, then the site with it.
    v_new_repo := gen_random_uuid();
    INSERT INTO repositories (id, organization_id, provider, installation_id, external_id, owner, name, default_branch, linked_by)
    VALUES (v_new_repo, v_vwt, v_repo.provider, v_repo.installation_id, v_repo.external_id, v_repo.owner, v_repo.name,
            v_repo.default_branch, v_repo.linked_by);
    INSERT INTO audit_events (organization_id, actor_user_id, action, target)
    VALUES (v_vwt, NULL, 'repository.linked', v_repo.owner || '/' || v_repo.name || ' (from Branding Centres, migration 0030)');
    RAISE NOTICE '[vwt-site] MOVED  repository %/%', v_repo.owner, v_repo.name;
  ELSIF v_site.repository_id IS NOT NULL THEN
    RAISE NOTICE '[vwt-site] the repository it named is no longer linked; the site moves without one.';
  END IF;

  INSERT INTO site_connections (organization_id, channel, site_url, repository_id, connected_by)
  VALUES (v_vwt, 'website', v_site.site_url, v_new_repo, v_site.connected_by);
  INSERT INTO audit_events (organization_id, actor_user_id, action, target)
  VALUES (v_vwt, NULL, 'site.connected', v_site.site_url || ' (from Branding Centres, migration 0030)');

  RAISE NOTICE '[vwt-site] MOVED  % to vinyl-wrap-toronto', v_site.site_url;
END
$$;
