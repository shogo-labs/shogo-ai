-- Migration: add_affiliate_system
-- Source:    prisma/schema.local.prisma
--
-- SQLite mirror of prisma/migrations/20260525000000_add_affiliate_system.
-- SQLite has no native enums — enum columns are TEXT with the same
-- string values used by the PG enum types. The commission engine
-- (apps/api/src/services/affiliate.service.ts) reads/writes string
-- constants and does the casting per the wrapForSqlite layer in
-- apps/api/src/lib/prisma.ts.

-- CreateTable
CREATE TABLE "affiliates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "parentAffiliateId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "stripeCustomAccountId" TEXT,
    "payoutStatus" TEXT NOT NULL DEFAULT 'not_setup',
    "payoutDetailsSubmittedAt" DATETIME,
    "totalEarningsCents" INTEGER NOT NULL DEFAULT 0,
    "pendingPayoutCents" INTEGER NOT NULL DEFAULT 0,
    "totalPaidOutCents" INTEGER NOT NULL DEFAULT 0,
    "termsAcceptedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "affiliates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "affiliates_parentAffiliateId_fkey" FOREIGN KEY ("parentAffiliateId") REFERENCES "affiliates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliates_userId_key" ON "affiliates"("userId");
CREATE UNIQUE INDEX "affiliates_code_key" ON "affiliates"("code");
CREATE INDEX "affiliates_parentAffiliateId_idx" ON "affiliates"("parentAffiliateId");
CREATE INDEX "affiliates_status_idx" ON "affiliates"("status");

-- CreateTable
CREATE TABLE "affiliate_clicks" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "affiliate_clicks_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "affiliate_clicks_visitorId_createdAt_idx" ON "affiliate_clicks"("visitorId", "createdAt");
CREATE INDEX "affiliate_clicks_affiliateId_createdAt_idx" ON "affiliate_clicks"("affiliateId", "createdAt");
CREATE INDEX "affiliate_clicks_expiresAt_idx" ON "affiliate_clicks"("expiresAt");

-- CreateTable
CREATE TABLE "affiliate_attributions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "visitorId" TEXT,
    "clickId" TEXT,
    "attributedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "affiliate_attributions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "affiliate_attributions_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliates" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "affiliate_attributions_clickId_fkey" FOREIGN KEY ("clickId") REFERENCES "affiliate_clicks" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_attributions_userId_key" ON "affiliate_attributions"("userId");
CREATE INDEX "affiliate_attributions_affiliateId_idx" ON "affiliate_attributions"("affiliateId");

-- CreateTable
CREATE TABLE "affiliate_payouts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "affiliateId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "stripePayoutId" TEXT,
    "stripeTransferId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "paidAt" DATETIME,
    "failureReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "affiliate_payouts_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "affiliate_payouts_affiliateId_createdAt_idx" ON "affiliate_payouts"("affiliateId", "createdAt");
CREATE INDEX "affiliate_payouts_status_idx" ON "affiliate_payouts"("status");

-- CreateTable
CREATE TABLE "affiliate_commissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "affiliateId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "referredWorkspaceId" TEXT,
    "stripeInvoiceId" TEXT,
    "stripeChargeId" TEXT,
    "level" INTEGER NOT NULL,
    "basisCents" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "eligibleAt" DATETIME NOT NULL,
    "payoutId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "affiliate_commissions_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliates" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "affiliate_commissions_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "affiliate_payouts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_commissions_stripeInvoiceId_affiliateId_level_key" ON "affiliate_commissions"("stripeInvoiceId", "affiliateId", "level");
CREATE INDEX "affiliate_commissions_affiliateId_status_idx" ON "affiliate_commissions"("affiliateId", "status");
CREATE INDEX "affiliate_commissions_eligibleAt_status_idx" ON "affiliate_commissions"("eligibleAt", "status");
CREATE INDEX "affiliate_commissions_stripeChargeId_idx" ON "affiliate_commissions"("stripeChargeId");

-- CreateTable
CREATE TABLE "affiliate_commission_tiers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "durationDays" INTEGER,
    "label" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_commission_tiers_level_key" ON "affiliate_commission_tiers"("level");

-- Seed default tiers (L1=20%, L2=5%, L3=2%, 365-day window each).
INSERT OR IGNORE INTO "affiliate_commission_tiers" ("id", "level", "rateBps", "durationDays", "label") VALUES
    ('aff_tier_l1', 1, 2000, 365, 'Direct referral'),
    ('aff_tier_l2', 2, 500,  365, 'Level 2 upline'),
    ('aff_tier_l3', 3, 200,  365, 'Level 3 upline');
