-- Migration: per-affiliate commission-rate override.
--
-- Adds an optional `commissionRateBps` column to `affiliates` (see
-- prisma/schema.prisma `Affiliate` and the commission engine in
-- apps/api/src/services/affiliate.service.ts). When set, it replaces the
-- per-level `AffiliateCommissionTier` rate for THIS affiliate's direct (L1)
-- referrals and is applied as a flat rate — the tier's `durationDays` window
-- and `secondaryRateBps` step-down are bypassed at L1. NULL preserves the
-- default behavior of using the tier rate. Only level 1 is affected; deeper
-- upline levels always use tier rates.
--
-- Basis points: 2000 = 20.00%. No backfill — existing affiliates stay NULL
-- and continue earning at the tier rate.

-- AlterTable
ALTER TABLE "affiliates" ADD COLUMN "commissionRateBps" INTEGER;
