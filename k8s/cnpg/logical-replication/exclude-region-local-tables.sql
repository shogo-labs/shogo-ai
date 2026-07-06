-- Re-assert the region-local exclusion of the additive-counter tables from the
-- cross-region publication `shogo_all_pub`.
--
-- WHY THIS EXISTS
-- ---------------
-- `storage_usage` and `usage_wallets` are 🔴 additive counters (running USD /
-- byte totals). They corrupt under logical replication's last_update_wins and
-- their `workspaceId` unique index poison-pills the apply worker when two
-- regions insert. They are therefore REGION-LOCAL: deliberately excluded from
-- `shogo_all_pub` until the single-writer work lands and they can safely rejoin
-- the mesh. See docs/runbooks/usage-wallet-single-writer-plan.md.
--
-- THE DRIFT THIS GUARDS
-- ---------------------
-- The Publication CR (k8s/cnpg/production-*-oci/platform-publication.yaml)
-- declares `FOR TABLES IN SCHEMA public`, which CANNOT exclude individual
-- tables. To exclude these two, the LIVE publication is a hand-list
-- (puballtables=f). deploy.yml re-applies the CR every deploy; CNPG 1.29 does
-- not re-diff membership on a no-op apply, so the exclusion has survived — but a
-- CR spec change or operator upgrade could reconcile the pub back to a
-- schema-level publication and silently re-add both tables, reintroducing the
-- poison pills. This script re-asserts the exclusion on every deploy and, if it
-- detects that the pub HAS been reconciled to a schema-level publication, FAILS
-- LOUD instead of silently poison-pilling.
--
-- Idempotent. Run on the local primary after `kubectl apply` of the Publication
-- CR and before `ALTER SUBSCRIPTION ... REFRESH PUBLICATION`.
\set ON_ERROR_STOP on

DO $$
DECLARE
  is_schema_pub boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'shogo_all_pub') THEN
    RAISE NOTICE 'shogo_all_pub does not exist yet; nothing to exclude';
    RETURN;
  END IF;

  -- A `FOR TABLES IN SCHEMA public` publication has a pg_publication_namespace
  -- row; a hand-list (`FOR TABLE ...`) does not.
  SELECT EXISTS (
    SELECT 1
    FROM pg_publication_namespace pn
    JOIN pg_publication p ON p.oid = pn.pnpubid
    WHERE p.pubname = 'shogo_all_pub'
  ) INTO is_schema_pub;

  IF is_schema_pub THEN
    RAISE EXCEPTION
      'shogo_all_pub is a FOR-TABLES-IN-SCHEMA publication — storage_usage/usage_wallets cannot be excluded and REFRESH would poison-pill the additive counters. CNPG re-reconciled the CR to a schema-level publication. Resolve per docs/runbooks/usage-wallet-single-writer-plan.md (finish single-writer + rejoin, or convert back to a hand-list) before continuing.';
  END IF;

  -- Hand-list publication: drop each region-local table if still present.
  IF EXISTS (SELECT 1 FROM pg_publication_tables
             WHERE pubname='shogo_all_pub' AND tablename='storage_usage') THEN
    ALTER PUBLICATION shogo_all_pub DROP TABLE storage_usage;
    RAISE NOTICE 'Excluded storage_usage from shogo_all_pub';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_publication_tables
             WHERE pubname='shogo_all_pub' AND tablename='usage_wallets') THEN
    ALTER PUBLICATION shogo_all_pub DROP TABLE usage_wallets;
    RAISE NOTICE 'Excluded usage_wallets from shogo_all_pub';
  END IF;

  RAISE NOTICE 'shogo_all_pub region-local exclusion asserted (hand-list; storage_usage + usage_wallets excluded)';
END $$;
