-- Migration: SHO-339 Subscription.stripePriceId
-- Source:    prisma/schema.local.prisma
--
-- Allowances follow the price: a Business seat sold at $40 keeps its
-- $9.90/week allowance until its next renewal moves it to the $16 price.
-- Nullable and additive; null means "predates the backfill" and resolves to
-- the legacy Business allowance (see `getPlanAllowance`).

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "stripePriceId" TEXT;
