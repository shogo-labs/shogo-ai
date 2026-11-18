-- Migration: SHO-409 Subscription.firstPaidAt
-- Source:    prisma/schema.local.prisma
--
-- Overage must never be the first real charge on a card. Nullable and
-- additive; `invoice.payment_succeeded` sets it the first time a real
-- (amount_paid > 0) invoice clears. See prisma/schema.prisma for full
-- semantics.
--
-- Backfill so existing payers are unchanged on deploy: active / past_due
-- subscriptions have been charged → currentPeriodStart. Trialing and
-- cancelled-trial rows stay NULL. (The cloud tree also backfills from
-- `usage_wallets.overagePaidBlocks`; the desktop wallet has no such column —
-- local mode has no Stripe overage billing.)

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "firstPaidAt" DATETIME;

-- Backfill: non-trialing subscriptions have been charged.
UPDATE "subscriptions"
SET "firstPaidAt" = "currentPeriodStart"
WHERE "status" IN ('active', 'past_due');
