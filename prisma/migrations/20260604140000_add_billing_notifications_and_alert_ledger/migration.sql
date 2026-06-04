-- Billing/usage notifications + proactive alert dedupe ledger.
--
-- Adds billing-related values to the NotificationType enum (consumed by the
-- billing fan-out in apps/api/src/services/notification.service.ts) and an
-- `alertsSentThisPeriod` JSONB column to usage_wallets so each proactive
-- usage/overage threshold alert fires at most once per allocation period
-- (reset alongside overageBilledUsd on the monthly allocation reset).

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'payment_succeeded';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'payment_failed';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'overage_charged';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'usage_threshold';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'spend_limit_reached';

-- AlterTable
ALTER TABLE "usage_wallets" ADD COLUMN "alertsSentThisPeriod" JSONB;
