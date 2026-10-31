-- Migration: sho258_activation_columns
-- PG: prisma/migrations/20261030205700_sho258_activation_columns
--
-- Keys the activation funnel and the lifecycle nudges off the database instead
-- of timers (SHO-258 §§2,4,7):
--   users.firstCapHitAt        the first 402 a usage gate answered for this user
--   users.firstPreviewSeenAt   the first time they opened one of their previews
--   usage_wallets.capNotifyPendingAt  a cap fired and "your agent is back" is owed

-- AlterTable
ALTER TABLE "usage_wallets" ADD COLUMN "capNotifyPendingAt" DATETIME;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "firstCapHitAt" DATETIME;
ALTER TABLE "users" ADD COLUMN "firstPreviewSeenAt" DATETIME;
