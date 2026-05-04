-- ============================================================================
-- Rollback: Credits -> USD (v1.5.0)
-- ============================================================================
-- INVERSE of prisma/migrations/20260424000000_credits_to_usd/migration.sql
-- AND prisma/migrations/20260429210000_add_overage_billed_trust/migration.sql.
--
-- Run this ONLY if we need to revert the v1.5.0 code deploy AND the
-- billing data must be readable by v1.4.3 again. Do NOT run if
-- migrate-tier-subscriptions.ts has already executed — that changes live
-- Stripe subscription items in ways that cannot be unwound by SQL.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/rollback-credits-to-usd-migration.sql
--
-- Behaviour:
--   * Renames usage_wallets -> credit_ledgers and each new USD column back
--     to the legacy credit-named column, dividing by 0.10 to restore the
--     legacy credit count (inverse of the original conversion).
--   * Drops the overage + metered-price columns added in 20260424000000 and
--     20260429210000 (overageEnabled, overageHardLimitUsd,
--     overageAccumulatedUsd, stripeMeteredItemId, overageBilledUsd).
--   * Reverts usage_events.billedUsd -> creditCost and source -> creditSource
--     (dividing by 0.10 to restore credit amounts). Drops rawUsd.
--   * Renames UsageSource -> CreditSource. We cannot remove the 'overage'
--     enum value in place in PostgreSQL, so we recreate the type.
--   * Recreates billing_accounts.creditsBalance (defaults to 0 — data is
--     NOT recoverable; legacy code allocates from CreditLedger anyway).
--   * Reverts analytics_digests.totalSpendUsd -> totalCreditsUsed (dividing
--     by 0.10).
--
-- Idempotency: this script uses IF EXISTS guards where possible, but
-- running it twice is undefined. Take a backup first.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. usage_events: revert USD columns to credit columns
-- ---------------------------------------------------------------------------

-- Convert billedUsd back to creditCost at the legacy $0.10 / credit rate.
UPDATE "usage_events" SET "billedUsd" = "billedUsd" / 0.10;

ALTER TABLE "usage_events" RENAME COLUMN "billedUsd" TO "creditCost";
ALTER TABLE "usage_events" RENAME COLUMN "source"     TO "creditSource";
ALTER TABLE "usage_events" DROP  COLUMN IF EXISTS "rawUsd";

-- Recreate CreditSource enum without the 'overage' value and swap the column
-- over. Cannot just rename UsageSource back because we need to drop the new
-- 'overage' variant that v1.4.3 has no UPDATE path for.
CREATE TYPE "CreditSource" AS ENUM ('daily', 'monthly');
ALTER TABLE "usage_events"
  ALTER COLUMN "creditSource" TYPE "CreditSource"
  USING (
    CASE "creditSource"::text
      WHEN 'overage' THEN 'monthly'::"CreditSource"
      ELSE "creditSource"::text::"CreditSource"
    END
  );

DROP TYPE "UsageSource";

-- ---------------------------------------------------------------------------
-- 2. usage_wallets: drop new columns and rename back to credit_ledgers
-- ---------------------------------------------------------------------------

ALTER TABLE "usage_wallets" DROP COLUMN IF EXISTS "overageBilledUsd";
ALTER TABLE "usage_wallets" DROP COLUMN IF EXISTS "stripeMeteredItemId";
ALTER TABLE "usage_wallets" DROP COLUMN IF EXISTS "overageAccumulatedUsd";
ALTER TABLE "usage_wallets" DROP COLUMN IF EXISTS "overageHardLimitUsd";
ALTER TABLE "usage_wallets" DROP COLUMN IF EXISTS "overageEnabled";

-- Invert the USD conversion back to credits.
UPDATE "usage_wallets" SET
  "monthlyIncludedUsd"            = "monthlyIncludedUsd" / 0.10,
  "dailyIncludedUsd"              = "dailyIncludedUsd" / 0.10,
  "monthlyIncludedAllocationUsd"  = "monthlyIncludedAllocationUsd" / 0.10,
  "dailyUsedThisMonthUsd"         = "dailyUsedThisMonthUsd" / 0.10;

ALTER TABLE "usage_wallets" RENAME COLUMN "monthlyIncludedUsd"           TO "monthlyCredits";
ALTER TABLE "usage_wallets" RENAME COLUMN "dailyIncludedUsd"             TO "dailyCredits";
ALTER TABLE "usage_wallets" RENAME COLUMN "monthlyIncludedAllocationUsd" TO "monthlyAllocation";
ALTER TABLE "usage_wallets" RENAME COLUMN "dailyUsedThisMonthUsd"        TO "dailyCreditsDispensedThisMonth";

ALTER TABLE "usage_wallets" RENAME TO "credit_ledgers";

-- ---------------------------------------------------------------------------
-- 3. billing_accounts.creditsBalance — recreate (data is lost)
-- ---------------------------------------------------------------------------

ALTER TABLE "billing_accounts" ADD COLUMN "creditsBalance" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 4. analytics_digests: totalSpendUsd -> totalCreditsUsed
-- ---------------------------------------------------------------------------

UPDATE "analytics_digests" SET "totalSpendUsd" = "totalSpendUsd" / 0.10;
ALTER TABLE "analytics_digests" RENAME COLUMN "totalSpendUsd" TO "totalCreditsUsed";

-- ---------------------------------------------------------------------------
-- 5. Prisma _prisma_migrations: delete the three billing migration rows
--    so re-deploying v1.5.0 will re-run them cleanly.
-- ---------------------------------------------------------------------------

DELETE FROM "_prisma_migrations" WHERE "migration_name" IN (
  '20260424000000_credits_to_usd',
  '20260428210000_add_subscription_seats',
  '20260429210000_add_overage_billed_trust'
);

-- ---------------------------------------------------------------------------
-- 6. subscriptions: drop the seats column
-- ---------------------------------------------------------------------------
-- Safe to drop: legacy code doesn't reference it and the v1.4.3 Stripe
-- subscription items still carry the quantity, so no data is lost that
-- the old code could have used.

ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "seats";

COMMIT;

-- ============================================================================
-- Verification
-- ============================================================================
-- After running, expected state:
--   \d credit_ledgers    -- table exists with monthlyCredits, dailyCredits
--   \d usage_events      -- has creditCost + creditSource columns, no rawUsd
--   \d billing_accounts  -- has creditsBalance column (default 0)
--   \d subscriptions     -- no seats column
--   \dT                  -- CreditSource enum exists, no UsageSource
-- ============================================================================
