-- Migration: Subscription.firstPaidAt (SHO-409).
--
-- Overage must never be the first real charge on a card. A trialing
-- subscription counts as a paid tier, so once its windows and promo credit are
-- spent it fell through to overage — and the first invoice the card ever saw
-- was our $25 overage block. For the fraud trials of Nov 2026 that charge
-- failed every time (~$370 unrecoverable). `resolveEffectivePlan` now gates
-- overage on `firstPaidAt`, which `invoice.payment_succeeded` sets the first
-- time a real (amount_paid > 0) invoice clears.
--
-- Nullable and additive. Backfill so existing payers are unchanged on deploy:
--   * active / past_due subscriptions have been charged → currentPeriodStart.
--   * a workspace whose wallet has paid overage blocks has demonstrably paid,
--     even if its subscription status is not active/past_due.
-- Trialing and cancelled-trial rows stay NULL: their card has never been
-- charged, which is exactly the state the gate is meant to catch.

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "firstPaidAt" TIMESTAMP(3);

-- Backfill: non-trialing subscriptions have been charged.
UPDATE "subscriptions"
SET "firstPaidAt" = "currentPeriodStart"
WHERE "status" IN ('active', 'past_due');

-- Backfill: a workspace that has paid overage blocks has demonstrably paid.
UPDATE "subscriptions" s
SET "firstPaidAt" = s."currentPeriodStart"
FROM "usage_wallets" w
WHERE w."workspaceId" = s."workspaceId"
  AND w."overagePaidBlocks" > 0
  AND s."firstPaidAt" IS NULL
  AND s."status" <> 'trialing';
