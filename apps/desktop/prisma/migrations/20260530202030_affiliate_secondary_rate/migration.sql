-- Migration: affiliate_secondary_rate
-- Source:    prisma/schema.local.prisma
--
-- Adds an optional step-down commission rate to affiliate tiers. After a
-- tier's `durationDays` window expires, `secondaryRateBps` (if set) is the
-- rate paid forever after (e.g. 20% for year one -> 10% thereafter). NULL
-- preserves the legacy behavior where the level simply stops earning.
-- Seeds the direct-referrer tier (level 1) with a 10% (1000 bps) step-down.
--
-- Scoped to the affiliate change only; pre-existing ACCEPTED_DRIFT
-- redefinitions of other tables (see scripts/check-desktop-schema-drift.ts)
-- are intentionally left out.

-- AlterTable
ALTER TABLE "affiliate_commission_tiers" ADD COLUMN "secondaryRateBps" INTEGER;

-- Seed: direct referral steps down to 10% after its 365-day window.
UPDATE "affiliate_commission_tiers" SET "secondaryRateBps" = 1000 WHERE "level" = 1;
