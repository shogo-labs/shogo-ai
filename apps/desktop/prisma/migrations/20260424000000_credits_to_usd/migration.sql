-- SQLite migration: Credits -> USD usage-based billing
--
-- Mirrors the Postgres migration at
-- prisma/migrations/20260424000000_credits_to_usd/migration.sql but adapted
-- for SQLite (no enum types, REAL instead of DOUBLE PRECISION, no
-- monthlyAllocation rename — SQLite baseline never had that column).
--
-- Legacy credit balances are converted to USD at $0.10/credit
-- (CREDIT_DOLLAR_VALUE in the pre-migration code).

PRAGMA foreign_keys = OFF;

-- ---------------------------------------------------------------------------
-- 1. credit_ledgers → usage_wallets, columns converted to USD
-- ---------------------------------------------------------------------------

ALTER TABLE "credit_ledgers" RENAME TO "usage_wallets";

ALTER TABLE "usage_wallets" RENAME COLUMN "monthlyCredits"                 TO "monthlyIncludedUsd";
ALTER TABLE "usage_wallets" RENAME COLUMN "dailyCredits"                   TO "dailyIncludedUsd";
ALTER TABLE "usage_wallets" RENAME COLUMN "dailyCreditsDispensedThisMonth" TO "dailyUsedThisMonthUsd";

UPDATE "usage_wallets" SET
  "monthlyIncludedUsd"    = "monthlyIncludedUsd"    * 0.10,
  "dailyIncludedUsd"      = "dailyIncludedUsd"      * 0.10,
  "dailyUsedThisMonthUsd" = "dailyUsedThisMonthUsd" * 0.10;

ALTER TABLE "usage_wallets" ADD COLUMN "monthlyIncludedAllocationUsd" REAL NOT NULL DEFAULT 0;
ALTER TABLE "usage_wallets" ADD COLUMN "overageEnabled"               BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "usage_wallets" ADD COLUMN "overageHardLimitUsd"          REAL;
ALTER TABLE "usage_wallets" ADD COLUMN "overageAccumulatedUsd"        REAL NOT NULL DEFAULT 0;
ALTER TABLE "usage_wallets" ADD COLUMN "stripeMeteredItemId"          TEXT;

-- Seed the new allocation column from the current monthly balance — on first
-- allocate after migration the refill code sets this to the plan's included
-- USD anyway, but this keeps the invariant (allocation >= included) sane for
-- already-allocated workspaces.
UPDATE "usage_wallets" SET "monthlyIncludedAllocationUsd" = "monthlyIncludedUsd";

-- The unique index `credit_ledgers_workspaceId_key` survives the RENAME TO as
-- a SQLite-internal name referencing the new table; re-create with the
-- conventional name so Prisma's introspection matches.
DROP INDEX IF EXISTS "credit_ledgers_workspaceId_key";
CREATE UNIQUE INDEX "usage_wallets_workspaceId_key" ON "usage_wallets"("workspaceId");

-- ---------------------------------------------------------------------------
-- 2. usage_events: credit columns → USD
-- ---------------------------------------------------------------------------

ALTER TABLE "usage_events" RENAME COLUMN "creditCost"   TO "billedUsd";
ALTER TABLE "usage_events" RENAME COLUMN "creditSource" TO "source";
ALTER TABLE "usage_events" ADD COLUMN   "rawUsd"       REAL;

UPDATE "usage_events" SET "billedUsd" = "billedUsd" * 0.10;

-- ---------------------------------------------------------------------------
-- 3. billing_accounts: drop unused creditsBalance
-- ---------------------------------------------------------------------------

ALTER TABLE "billing_accounts" DROP COLUMN "creditsBalance";

-- ---------------------------------------------------------------------------
-- 4. analytics_digests: totalCreditsUsed → totalSpendUsd (USD)
-- ---------------------------------------------------------------------------

ALTER TABLE "analytics_digests" RENAME COLUMN "totalCreditsUsed" TO "totalSpendUsd";
UPDATE "analytics_digests" SET "totalSpendUsd" = "totalSpendUsd" * 0.10;

PRAGMA foreign_keys = ON;
