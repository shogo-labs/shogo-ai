-- Migration: SHO-312 per-member rolling usage windows
-- Source:    prisma/schema.local.prisma
--
-- Per-seat AI allowance: each member meters their own weekly / 5-hour windows
-- instead of the shared workspace wallet. Additive; existing wallet counters
-- are left untouched. Scoped to the new columns only.

-- AlterTable
ALTER TABLE "members" ADD COLUMN "fiveHourWindowStart" DATETIME;
ALTER TABLE "members" ADD COLUMN "fiveHourUsedUsd" REAL NOT NULL DEFAULT 0;
ALTER TABLE "members" ADD COLUMN "weeklyWindowStart" DATETIME;
ALTER TABLE "members" ADD COLUMN "weeklyUsedUsd" REAL NOT NULL DEFAULT 0;
