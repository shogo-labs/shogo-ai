-- Tag each daily analytics digest with the region that produced it and
-- fold `region` into the unique key. Background: the analytics-digest
-- cron runs in every region (US/EU/India) and every region inserts a
-- row with a fresh UUID but the SAME `(date, period)` natural key. With
-- bidirectional logical replication between regions this triggers an
-- unrecoverable 23505 on `analytics_digests_date_period_key` and pins
-- the apply workers (see 2026-05-21 incident: India and US apply
-- workers both stuck on 08:00:00 UTC digest, blocking ALL user/project
-- replication for any user that signed up exclusively in one region).
--
-- `region` is intentionally NULLABLE in this first migration so the
-- historical poison-pill INSERT payloads (decoded from WAL written
-- before this column existed) land cleanly as `region = NULL`, which
-- under the new compound unique key is distinct from the backfilled
-- `region = '<local>'` row already present locally. The apply workers
-- advance, we backfill, then a follow-up migration tightens this to
-- NOT NULL.

-- DropIndex
DROP INDEX "analytics_digests_date_period_key";

-- AlterTable
ALTER TABLE "analytics_digests" ADD COLUMN     "region" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "analytics_digests_date_period_region_key" ON "analytics_digests"("date", "period", "region");
