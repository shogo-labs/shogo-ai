-- Migration: rolling usage windows (time-gated "unlimited" plans).
--
-- Adds two parallel rolling windows to the usage wallet (see
-- prisma/schema.prisma `UsageWallet` and apps/api/src/config/usage-plans.ts):
--   - fiveHourWindowStart / fiveHourUsedUsd: 5-hour burst window
--   - weeklyWindowStart / weeklyUsedUsd:     7-day window
-- Each window accumulates marked-up USD of compute and resets when its
-- duration elapses. NULL start = the window has not yet been opened.
--
-- Also adds the `window` value to the UsageSource enum so usage events
-- charged against a rolling window (rather than the legacy daily/monthly
-- pools) are labeled distinctly.

-- AlterEnum
ALTER TYPE "UsageSource" ADD VALUE IF NOT EXISTS 'window';

-- AlterTable
ALTER TABLE "usage_wallets" ADD COLUMN "fiveHourWindowStart" TIMESTAMP(3);
ALTER TABLE "usage_wallets" ADD COLUMN "fiveHourUsedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "usage_wallets" ADD COLUMN "weeklyWindowStart" TIMESTAMP(3);
ALTER TABLE "usage_wallets" ADD COLUMN "weeklyUsedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
