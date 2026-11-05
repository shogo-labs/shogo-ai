-- Migration: Subscription.stripePriceId (SHO-339, SHO-312 Phase 5).
--
-- Allowances follow the price, not just the plan name: a Business seat sold at
-- $40 keeps its $9.90/week allowance until its next renewal moves it to the
-- $16 price. Nullable and additive — existing rows start null, which
-- `getPlanAllowance` deliberately treats as the legacy Business allowance
-- until `scripts/migrate-phase5-subscriptions.ts` backfills the real price.

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "stripePriceId" TEXT;
