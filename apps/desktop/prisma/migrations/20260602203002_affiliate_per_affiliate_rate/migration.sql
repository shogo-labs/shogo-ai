-- Migration: affiliate_per_affiliate_rate
-- Source:    prisma/schema.local.prisma
--
-- Adds an optional per-affiliate commission-rate override to the `affiliates`
-- table. When set (basis points; 2000 = 20.00%), it replaces the per-level
-- `AffiliateCommissionTier` rate for that affiliate's direct (L1) referrals and
-- is applied as a flat rate — the tier's durationDays window and
-- secondaryRateBps step-down are bypassed at L1. NULL = use the tier rate.
-- See apps/api/src/services/affiliate.service.ts:recordCommissionsForInvoice.
--
-- Scoped to the affiliate change only; pre-existing ACCEPTED_DRIFT
-- redefinitions of other tables (see scripts/check-desktop-schema-drift.ts)
-- are intentionally left out.

-- AlterTable
ALTER TABLE "affiliates" ADD COLUMN "commissionRateBps" INTEGER;
