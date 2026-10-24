-- Migration: social_usage_meters
-- Source:    prisma/schema.local.prisma
--
-- SQLite mirror of prisma/migrations/20261019180000_social_usage_meters.
-- The desktop records both columns even though only the cloud charges: the rows
-- travel to the cloud through the relay, and the two schemas must not drift.

-- AlterTable
ALTER TABLE "social_accounts" ADD COLUMN "monthlyRateDebitedFor" DATETIME;

-- AlterTable
ALTER TABLE "social_post_targets" ADD COLUMN "meteredAt" DATETIME;
