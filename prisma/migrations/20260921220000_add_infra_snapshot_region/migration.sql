-- infra_snapshots is replicated to every region via the bidirectional
-- logical-replication mesh (see docs/oci-multi-region-production-guide.md),
-- so historically it has been impossible to tell which region's collector
-- wrote a given row -- and `/analytics/infra-history` had no way to scope a
-- region's chart to that region's own data, silently returning the blended
-- global history for every region instead.
--
-- Existing rows are left NULL (unknown writer). Nullable + no backfill is
-- intentional: we cannot reliably attribute historical rows to a region, and
-- the API falls back to including NULL-region rows in the query window so
-- existing charts keep rendering while new, correctly-tagged rows accumulate.
ALTER TABLE "infra_snapshots" ADD COLUMN "region" TEXT;

CREATE INDEX "infra_snapshots_region_timestamp_idx" ON "infra_snapshots"("region", "timestamp");
