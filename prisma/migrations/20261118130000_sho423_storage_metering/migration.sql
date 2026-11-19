-- Migration: storage metering for billing (SHO-423).
--
-- storage_usage gains the per-category/per-project breakdown it already pays to
-- compute and the billable (non-overhead) byte total:
--   * billableBytes — totalBytes minus the platform-overhead categories
--     (conflict quarantine archives, metal VM snapshots), i.e. what a customer
--     is charged for. Backfilled as totalBytes for existing rows: the
--     overhead categories were never measured before this pass, so there is
--     nothing to subtract; the next 6h pass corrects it.
--   * breakdown — `{ categories, projects, unmeasured }` JSON. Null means "not
--     measured since the column landed".
--
-- storage_usage_daily — one row per workspace per UTC day holding the MAXIMUM
-- bytes seen that day, plus the accrued USD. Region-local like storage_usage:
-- excluded from shogo_all_pub (see
-- k8s/cnpg/logical-replication/exclude-region-local-tables.sql).
--
-- Additive and idempotent for existing data: nothing is rewritten but the
-- billableBytes backfill, and the daily table starts empty.

-- AlterTable
ALTER TABLE "storage_usage" ADD COLUMN "billableBytes" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "storage_usage" ADD COLUMN "breakdown" JSONB;

UPDATE "storage_usage" SET "billableBytes" = "totalBytes" WHERE "billableBytes" = 0;

-- CreateTable
CREATE TABLE "storage_usage_daily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "billableBytes" BIGINT NOT NULL DEFAULT 0,
    "allowanceBytes" BIGINT NOT NULL DEFAULT 0,
    "breakdown" JSONB,
    "chargedUsd" DOUBLE PRECISION,
    "billedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_usage_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storage_usage_daily_workspaceId_day_key" ON "storage_usage_daily"("workspaceId", "day");

-- CreateIndex
CREATE INDEX "storage_usage_daily_day_idx" ON "storage_usage_daily"("day");

-- AddForeignKey
ALTER TABLE "storage_usage_daily" ADD CONSTRAINT "storage_usage_daily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
