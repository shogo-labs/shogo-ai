-- ---------------------------------------------------------------------------
-- Discard replicated writes to `_prisma_migrations`.
--
-- Why this file exists
-- ====================
-- `shogo_all_pub` uses `FOR TABLES IN SCHEMA public`, which auto-publishes
-- every table in `public` — including `_prisma_migrations`. CNPG's
-- Publication CR does not expose row filters, and Postgres does not allow
-- `ALTER PUBLICATION ... DROP TABLE` against a `FOR TABLES IN SCHEMA`
-- publication. So we cannot exclude `_prisma_migrations` on the publisher
-- side.
--
-- Replicating `_prisma_migrations` corrupts Prisma's per-database tracking:
--
--   1. Prisma is supposed to maintain `_prisma_migrations` independently per
--      database. Replicating it means every region sees every other region's
--      migration rows.
--   2. Logical replication does not replicate DDL. So when US runs
--      `prisma migrate deploy`, the `_prisma_migrations` INSERT replicates
--      to EU/India but the new tables it creates do not. Any DML on those
--      new tables (e.g. seed inserts) then breaks replication on EU/India
--      with `relation "..." does not exist`, halting the apply worker
--      entirely and blocking ALL future writes from US.
--   3. Even when (2) is avoided (no seed DML), Prisma on EU/India queries
--      `_prisma_migrations`, sees the replicated row with `finished_at`
--      filled in, and **skips applying the DDL locally**. The subscriber
--      ends up a schema behind, with a "successful" tracking row covering
--      it up, until the next time the publisher writes to the missing
--      table and replication breaks.
--
-- Both failure modes were observed in production on 2026-05-26. See
-- the post-incident notes in this PR.
--
-- The fix
-- =======
-- Install a `BEFORE INSERT OR UPDATE OR DELETE` trigger on
-- `_prisma_migrations` that returns NULL — discards the row — and enable
-- it ONLY for replicated (replica-role) writes via `ENABLE REPLICA TRIGGER`.
--
--   * Local `prisma migrate deploy` continues to write to the table normally
--     (regular trigger semantics: REPLICA-only triggers do not fire on
--     locally-originated writes).
--   * Any change that arrives via the logical-replication apply worker is
--     silently dropped, so each region's `_prisma_migrations` reflects only
--     that region's own migration history.
--
-- The `DISABLE TRIGGER ... ENABLE REPLICA TRIGGER` pair is the canonical
-- way to express "fire only during replication" — see the Postgres docs
-- for `ALTER TABLE ... ENABLE/DISABLE TRIGGER` REPLICA mode.
--
-- Applied to every cluster (US, EU, India) on every deploy by
-- `.github/workflows/deploy.yml`. Idempotent.
--
-- Run as `postgres` (superuser).
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION skip_replicated_migrations() RETURNS trigger AS $f$
BEGIN
  -- Returning NULL from a BEFORE-row trigger discards the operation.
  -- The apply worker's transaction continues; only this row is dropped.
  RETURN NULL;
END;
$f$ LANGUAGE plpgsql;

-- Recreate the trigger so the binding is fresh on every run, in case the
-- function signature changes in the future.
DROP TRIGGER IF EXISTS skip_replicated_migrations_trg ON _prisma_migrations;
CREATE TRIGGER skip_replicated_migrations_trg
  BEFORE INSERT OR UPDATE OR DELETE ON _prisma_migrations
  FOR EACH ROW EXECUTE FUNCTION skip_replicated_migrations();

-- DISABLE for local writes; ENABLE REPLICA for replicated apply-worker writes.
-- These two statements together set the trigger's `tgenabled` column to 'R'
-- (replica). 'D' = disabled, 'O' = origin (default = local only),
-- 'A' = always (both), 'R' = replica only.
ALTER TABLE _prisma_migrations DISABLE TRIGGER skip_replicated_migrations_trg;
ALTER TABLE _prisma_migrations ENABLE REPLICA TRIGGER skip_replicated_migrations_trg;
