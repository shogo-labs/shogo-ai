-- AlterTable: change planId from PlanId enum to plain text so tiered plan IDs
-- (e.g. "business_1200") can be stored alongside base names ("pro").
ALTER TABLE "subscriptions" ALTER COLUMN "planId" SET DATA TYPE TEXT;

-- DropEnum: PlanId is no longer referenced by any column.
DROP TYPE "PlanId";
