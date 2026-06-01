-- Migration: add_rolling_usage_windows
-- Source:    prisma/schema.local.prisma
--
-- Adds the rolling usage-window columns (time-gated "unlimited" plans) to the
-- desktop SQLite mirror of `usage_wallets`. Each window accumulates marked-up
-- USD of compute and resets when its duration elapses; NULL start = the window
-- has not yet been opened. See apps/api/src/config/usage-plans.ts
-- (FIVE_HOUR_MS / SEVEN_DAY_MS, ROLLING_WINDOW_LIMITS).
--
-- Scoped to the new columns only; pre-existing ACCEPTED_DRIFT redefinitions of
-- usage_wallets and other tables (see scripts/check-desktop-schema-drift.ts)
-- are intentionally left out.

-- AlterTable
ALTER TABLE "usage_wallets" ADD COLUMN "fiveHourWindowStart" DATETIME;
ALTER TABLE "usage_wallets" ADD COLUMN "fiveHourUsedUsd" REAL NOT NULL DEFAULT 0;
ALTER TABLE "usage_wallets" ADD COLUMN "weeklyWindowStart" DATETIME;
ALTER TABLE "usage_wallets" ADD COLUMN "weeklyUsedUsd" REAL NOT NULL DEFAULT 0;
