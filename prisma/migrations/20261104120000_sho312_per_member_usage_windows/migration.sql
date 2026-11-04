-- Migration: per-member rolling usage windows (SHO-312).
--
-- The weekly / 5-hour AI allowance is now per seat, not per workspace: each
-- member meters their own windows and can never spend another seat's
-- allowance. `usage_wallets` keeps its counters for the free tier and for
-- unattributed (`system`) usage; paid plans read and write these columns.
--
-- Additive only — existing wallet counters are left untouched, so a workspace
-- that upgrades keeps its current window until it resets naturally.

-- AlterTable
ALTER TABLE "members" ADD COLUMN "fiveHourWindowStart" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "fiveHourUsedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "members" ADD COLUMN "weeklyWindowStart" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "weeklyUsedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
