-- Migration: native MLM affiliate system (replaces Rewardful).
--
-- Six new tables + three new enums. Opt-in: existing users see no
-- change until they explicitly enroll via POST /api/affiliates/enroll.
-- Per-level commission rates and the recurring-window live in
-- `affiliate_commission_tiers` (one row per level; number of rows
-- defines max upline depth, default 3 — seeded outside this DDL by
-- `prisma/seed.ts`).
--
-- See prisma/schema.prisma "AFFILIATE / MLM PROGRAM" section and
-- apps/api/src/services/affiliate.service.ts for full semantics.

-- CreateEnum
CREATE TYPE "AffiliateStatus" AS ENUM ('active', 'suspended', 'banned');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('pending', 'approved', 'paid', 'refunded', 'clawed_back', 'void');

-- CreateEnum
CREATE TYPE "PayoutBatchStatus" AS ENUM ('pending', 'sent', 'paid', 'failed');

-- CreateTable
CREATE TABLE "affiliates" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "parentAffiliateId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 1,
    "status" "AffiliateStatus" NOT NULL DEFAULT 'active',
    "stripeCustomAccountId" TEXT,
    "payoutStatus" "PayoutStatus" NOT NULL DEFAULT 'not_setup',
    "payoutDetailsSubmittedAt" TIMESTAMP(3),
    "totalEarningsCents" INTEGER NOT NULL DEFAULT 0,
    "pendingPayoutCents" INTEGER NOT NULL DEFAULT 0,
    "totalPaidOutCents" INTEGER NOT NULL DEFAULT 0,
    "termsAcceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliates_userId_key" ON "affiliates"("userId");
CREATE UNIQUE INDEX "affiliates_code_key" ON "affiliates"("code");
CREATE INDEX "affiliates_parentAffiliateId_idx" ON "affiliates"("parentAffiliateId");
CREATE INDEX "affiliates_status_idx" ON "affiliates"("status");

-- AddForeignKey
ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_parentAffiliateId_fkey" FOREIGN KEY ("parentAffiliateId") REFERENCES "affiliates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "affiliate_clicks" (
    "id" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "landingPage" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "referrer" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "affiliate_clicks_visitorId_createdAt_idx" ON "affiliate_clicks"("visitorId", "createdAt");
CREATE INDEX "affiliate_clicks_affiliateId_createdAt_idx" ON "affiliate_clicks"("affiliateId", "createdAt");
CREATE INDEX "affiliate_clicks_expiresAt_idx" ON "affiliate_clicks"("expiresAt");

-- AddForeignKey
ALTER TABLE "affiliate_clicks" ADD CONSTRAINT "affiliate_clicks_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "affiliate_attributions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "visitorId" TEXT,
    "clickId" TEXT,
    "attributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_attributions_userId_key" ON "affiliate_attributions"("userId");
CREATE INDEX "affiliate_attributions_affiliateId_idx" ON "affiliate_attributions"("affiliateId");

-- AddForeignKey
ALTER TABLE "affiliate_attributions" ADD CONSTRAINT "affiliate_attributions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "affiliate_attributions" ADD CONSTRAINT "affiliate_attributions_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "affiliate_attributions" ADD CONSTRAINT "affiliate_attributions_clickId_fkey" FOREIGN KEY ("clickId") REFERENCES "affiliate_clicks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "affiliate_payouts" (
    "id" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "stripePayoutId" TEXT,
    "stripeTransferId" TEXT,
    "status" "PayoutBatchStatus" NOT NULL DEFAULT 'pending',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "affiliate_payouts_affiliateId_createdAt_idx" ON "affiliate_payouts"("affiliateId", "createdAt");
CREATE INDEX "affiliate_payouts_status_idx" ON "affiliate_payouts"("status");

-- AddForeignKey
ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "affiliate_commissions" (
    "id" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "referredWorkspaceId" TEXT,
    "stripeInvoiceId" TEXT,
    "stripeChargeId" TEXT,
    "level" INTEGER NOT NULL,
    "basisCents" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "CommissionStatus" NOT NULL DEFAULT 'pending',
    "eligibleAt" TIMESTAMP(3) NOT NULL,
    "payoutId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_commissions_stripeInvoiceId_affiliateId_level_key" ON "affiliate_commissions"("stripeInvoiceId", "affiliateId", "level");
CREATE INDEX "affiliate_commissions_affiliateId_status_idx" ON "affiliate_commissions"("affiliateId", "status");
CREATE INDEX "affiliate_commissions_eligibleAt_status_idx" ON "affiliate_commissions"("eligibleAt", "status");
CREATE INDEX "affiliate_commissions_stripeChargeId_idx" ON "affiliate_commissions"("stripeChargeId");

-- AddForeignKey
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "affiliate_payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "affiliate_commission_tiers" (
    "id" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "durationDays" INTEGER,
    "label" TEXT,

    CONSTRAINT "affiliate_commission_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_commission_tiers_level_key" ON "affiliate_commission_tiers"("level");

-- Seed default tiers (L1=20%, L2=5%, L3=2%, all 365-day window). Safe
-- to re-run: ON CONFLICT (level) DO NOTHING on the unique constraint.
INSERT INTO "affiliate_commission_tiers" ("id", "level", "rateBps", "durationDays", "label") VALUES
    ('aff_tier_l1', 1, 2000, 365, 'Direct referral'),
    ('aff_tier_l2', 2, 500,  365, 'Level 2 upline'),
    ('aff_tier_l3', 3, 200,  365, 'Level 3 upline')
ON CONFLICT ("level") DO NOTHING;
