-- Reconcile the membership of the cross-region publication `shogo_all_pub`:
-- every table in `public` is published except the region-local ones.
--
-- REGION-LOCAL TABLES
-- -------------------
-- `storage_usage` and `usage_wallets` are 🔴 additive counters (running USD /
-- byte totals). They corrupt under logical replication's last_update_wins and
-- their `workspaceId` unique index poison-pills the apply worker when two
-- regions insert. They stay out of `shogo_all_pub` until the single-writer
-- work lands and they can safely rejoin the mesh. See
-- docs/runbooks/usage-wallet-single-writer-plan.md.
--
-- `proxy_turns` summarizes LLM traffic served by the local region. The raw
-- captures it points at live only in that region's bucket, and /api/ai/* is
-- not home-region routed, so the rows are kept (and pruned) where they were
-- written.
--
-- THE DRIFT THIS GUARDS
-- ---------------------
-- The Publication CR (k8s/cnpg/production-*-oci/platform-publication.yaml)
-- declares `FOR TABLES IN SCHEMA public`, which CANNOT exclude individual
-- tables. To exclude the region-local tables, the LIVE publication is a
-- hand-list (puballtables=f). deploy.yml re-applies the CR every deploy; CNPG
-- 1.29 does not re-diff membership on a no-op apply, so the hand-list survives,
-- but that also means tables created by migrations are NOT published until
-- this script adds them (nine tables went unpublished for two weeks this way).
-- A CR spec change or operator upgrade could instead reconcile the pub back to
-- a schema-level publication and silently re-add the region-local tables; if
-- that is detected this script FAILS LOUD instead of poison-pilling.
--
-- Idempotent. Run on the local primary after `kubectl apply` of the Publication
-- CR and before `ALTER SUBSCRIPTION ... REFRESH PUBLICATION`. Run it in every
-- region: each region publishes its own copy of the schema.
\set ON_ERROR_STOP on

DO $$
DECLARE
  region_local text[] := ARRAY['storage_usage', 'usage_wallets', 'proxy_turns'];
  is_schema_pub boolean;
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'shogo_all_pub') THEN
    RAISE NOTICE 'shogo_all_pub does not exist yet; nothing to reconcile';
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
      'shogo_all_pub is a FOR-TABLES-IN-SCHEMA publication — region-local tables (%) cannot be excluded and REFRESH would poison-pill the additive counters. CNPG re-reconciled the CR to a schema-level publication. Resolve per docs/runbooks/usage-wallet-single-writer-plan.md (finish single-writer + rejoin, or convert back to a hand-list) before continuing.',
      array_to_string(region_local, ', ');
  END IF;

  FOREACH t IN ARRAY region_local LOOP
    IF EXISTS (SELECT 1 FROM pg_publication_tables
               WHERE pubname = 'shogo_all_pub' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION shogo_all_pub DROP TABLE public.%I', t);
      RAISE NOTICE 'Excluded % from shogo_all_pub', t;
    END IF;
  END LOOP;

  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
      AND c.relname <> ALL (region_local)
      AND NOT EXISTS (
        SELECT 1 FROM pg_publication_tables pt
        WHERE pt.pubname = 'shogo_all_pub' AND pt.schemaname = 'public' AND pt.tablename = c.relname
      )
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER PUBLICATION shogo_all_pub ADD TABLE public.%I', t);
    RAISE NOTICE 'Published % in shogo_all_pub', t;
  END LOOP;

  RAISE NOTICE 'shogo_all_pub reconciled (hand-list; region-local: %)', array_to_string(region_local, ', ');
END $$;
