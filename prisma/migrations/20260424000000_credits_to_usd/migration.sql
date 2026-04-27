-- Migration: Credits -> USD usage-based billing
-- Converts credit_ledgers -> usage_wallets (columns in USD at $0.10/credit),
-- converts usage_events credit columns to USD, and drops unused BillingAccount.creditsBalance.

-- ---------------------------------------------------------------------------
-- 1. Rename table credit_ledgers -> usage_wallets and convert columns to USD
-- ---------------------------------------------------------------------------

ALTER TABLE "credit_ledgers" RENAME TO "usage_wallets";

ALTER TABLE "usage_wallets" RENAME COLUMN "monthlyCredits"                  TO "monthlyIncludedUsd";
ALTER TABLE "usage_wallets" RENAME COLUMN "dailyCredits"                    TO "dailyIncludedUsd";
ALTER TABLE "usage_wallets" RENAME COLUMN "monthlyAllocation"               TO "monthlyIncludedAllocationUsd";
ALTER TABLE "usage_wallets" RENAME COLUMN "dailyCreditsDispensedThisMonth"  TO "dailyUsedThisMonthUsd";

-- Convert existing credit balances to USD at $0.10/credit (legacy CREDIT_DOLLAR_VALUE).
UPDATE "usage_wallets" SET
  "monthlyIncludedUsd"            = "monthlyIncludedUsd" * 0.10,
  "dailyIncludedUsd"              = "dailyIncludedUsd" * 0.10,
  "monthlyIncludedAllocationUsd"  = "monthlyIncludedAllocationUsd" * 0.10,
  "dailyUsedThisMonthUsd"         = "dailyUsedThisMonthUsd" * 0.10;

-- New overage + metering columns.
ALTER TABLE "usage_wallets" ADD COLUMN "overageEnabled"        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "usage_wallets" ADD COLUMN "overageHardLimitUsd"   DOUBLE PRECISION;
ALTER TABLE "usage_wallets" ADD COLUMN "overageAccumulatedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "usage_wallets" ADD COLUMN "stripeMeteredItemId"   TEXT;

-- Rename existing indexes if any were auto-named against credit_ledgers.
-- Primary key + unique constraints are renamed automatically with the table in Postgres.

-- ---------------------------------------------------------------------------
-- 2. usage_events: credits -> USD, source enum gains "overage"
-- ---------------------------------------------------------------------------

-- Rename credit columns to USD columns.
ALTER TABLE "usage_events" RENAME COLUMN "creditCost"   TO "billedUsd";
ALTER TABLE "usage_events" RENAME COLUMN "creditSource" TO "source";

-- Add rawUsd (nullable: unknown for historical rows).
ALTER TABLE "usage_events" ADD COLUMN "rawUsd" DOUBLE PRECISION;

-- Convert historical billedUsd = creditCost * 0.10.
UPDATE "usage_events" SET "billedUsd" = "billedUsd" * 0.10;

-- Rename the CreditSource enum to UsageSource and add "overage".
ALTER TYPE "CreditSource" RENAME TO "UsageSource";
ALTER TYPE "UsageSource" ADD VALUE IF NOT EXISTS 'overage';

-- ---------------------------------------------------------------------------
-- 3. Drop unused BillingAccount.creditsBalance
-- ---------------------------------------------------------------------------

ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "creditsBalance";

-- ---------------------------------------------------------------------------
-- 4. analytics_digests: rename totalCreditsUsed -> totalSpendUsd (convert to USD)
-- ---------------------------------------------------------------------------

ALTER TABLE "analytics_digests" RENAME COLUMN "totalCreditsUsed" TO "totalSpendUsd";
UPDATE "analytics_digests" SET "totalSpendUsd" = "totalSpendUsd" * 0.10;
