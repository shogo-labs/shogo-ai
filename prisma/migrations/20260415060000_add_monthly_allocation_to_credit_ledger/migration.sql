-- AlterTable: Add monthlyAllocation to credit_ledgers
-- Stores the original monthly credit allocation so the UI can display
-- a stable "remaining / total" without the denominator decreasing with usage.
ALTER TABLE "credit_ledgers" ADD COLUMN "monthlyAllocation" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Backfill: set monthlyAllocation from the subscription's planId for existing ledgers.
-- For workspaces with an active subscription, derive the allocation from the planId.
-- Tiered plans (e.g. "business_1200") store half the credit amount as the suffix;
-- base plans ("pro", "business") use 200 credits.
UPDATE "credit_ledgers" cl
SET "monthlyAllocation" = CASE
  WHEN s."planId" ~ '^(pro|business)_[0-9]+$'
    THEN CAST(SPLIT_PART(s."planId", '_', 2) AS DOUBLE PRECISION) * 2
  WHEN s."planId" IN ('pro', 'business')
    THEN 200
  WHEN s."planId" = 'basic'
    THEN 50
  WHEN s."planId" LIKE 'enterprise%'
    THEN 20000
  ELSE 0
END
FROM "subscriptions" s
WHERE s."workspaceId" = cl."workspaceId"
  AND s."status" IN ('active', 'trialing');
