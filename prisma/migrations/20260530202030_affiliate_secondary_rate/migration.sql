-- Migration: affiliate secondary (step-down) commission rate.
--
-- Adds an optional second-phase rate to affiliate commission tiers (see
-- prisma/schema.prisma `AffiliateCommissionTier` and the commission engine
-- in apps/api/src/services/affiliate.service.ts). After a tier's
-- `durationDays` window expires, `secondaryRateBps` (if set) becomes the
-- rate paid forever after — e.g. 20% (2000 bps) for the first year, then
-- 10% (1000 bps) thereafter. NULL preserves the legacy behavior where the
-- level simply stops earning once its window ends.
--
-- Seeds the direct-referral tier (level 1) with a 10% step-down so the
-- default program pays 20% year one and 10% forever after.

-- AlterTable
ALTER TABLE "affiliate_commission_tiers" ADD COLUMN "secondaryRateBps" INTEGER;

-- Seed: direct referral steps down to 10% after its 365-day window.
UPDATE "affiliate_commission_tiers" SET "secondaryRateBps" = 1000 WHERE "level" = 1;
