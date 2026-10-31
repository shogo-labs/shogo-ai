-- Migration: sho258_activation_columns
-- Desktop:   apps/desktop/prisma/migrations/20261030205650_sho258_activation_columns
--
-- Keys the activation funnel and the lifecycle nudges off the database instead
-- of timers (SHO-258 §§2,4,7):
--   users.firstCapHitAt        the first 402 a usage gate answered for this user
--   users.firstPreviewSeenAt   the first time they opened one of their previews
--   usage_wallets.capNotifyPendingAt  a cap fired and "your agent is back" is owed
--
-- All three are nullable: existing rows stay null, which the funnel reads as
-- "never reached this step" and the job reads as "nothing owed".

-- AlterTable
ALTER TABLE "usage_wallets" ADD COLUMN "capNotifyPendingAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN "firstCapHitAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "firstPreviewSeenAt" TIMESTAMP(3);

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'build_ready';
ALTER TYPE "NotificationType" ADD VALUE 'credits_reset';
