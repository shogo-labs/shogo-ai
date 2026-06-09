-- Migration: add_affiliate_content_cpm
-- Source:    prisma/schema.local.prisma
--
-- Affiliate content-CPM tracking (Instagram / TikTok) — SQLite desktop
-- mirror of prisma/migrations/20260608000000_add_affiliate_content_cpm.
--
-- Hand-trimmed from the `bun run db:migrate:desktop` output: the raw
-- `prisma migrate diff` swept in unrelated pre-existing accepted-drift
-- tables (agent_configs, eval_runs, signup_attributions, …) that are on
-- the ACCEPTED_DRIFT allow-list in scripts/check-desktop-schema-drift.ts
-- and must NOT be redefined here. This migration contains ONLY the
-- content-CPM additions. The affiliate_commissions change is expressed as
-- additive ALTER TABLE + CREATE UNIQUE INDEX (no table rebuild needed:
-- the new column has a DEFAULT and the new unique index is additive).

-- CreateTable
CREATE TABLE "affiliate_social_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "affiliateId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "providerUserId" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'pending',
    "verificationCode" TEXT NOT NULL,
    "verifiedAt" DATETIME,
    "lastPolledAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "affiliate_social_accounts_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "affiliate_posts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "socialAccountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "providerPostId" TEXT NOT NULL,
    "url" TEXT,
    "caption" TEXT,
    "postedAt" DATETIME,
    "lastViews" INTEGER NOT NULL DEFAULT 0,
    "paidViews" INTEGER NOT NULL DEFAULT 0,
    "lastLikes" INTEGER NOT NULL DEFAULT 0,
    "lastComments" INTEGER NOT NULL DEFAULT 0,
    "lastShares" INTEGER NOT NULL DEFAULT 0,
    "lastPolledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "affiliate_posts_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "affiliate_social_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "affiliate_post_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "postId" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "affiliate_post_snapshots_postId_fkey" FOREIGN KEY ("postId") REFERENCES "affiliate_posts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "affiliate_commissions" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'referral';
ALTER TABLE "affiliate_commissions" ADD COLUMN "contentRunId" TEXT;

-- CreateIndex
CREATE INDEX "affiliate_social_accounts_affiliateId_idx" ON "affiliate_social_accounts"("affiliateId");

-- CreateIndex
CREATE INDEX "affiliate_social_accounts_verificationStatus_idx" ON "affiliate_social_accounts"("verificationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_social_accounts_platform_handle_key" ON "affiliate_social_accounts"("platform", "handle");

-- CreateIndex
CREATE INDEX "affiliate_posts_socialAccountId_idx" ON "affiliate_posts"("socialAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_posts_platform_providerPostId_key" ON "affiliate_posts"("platform", "providerPostId");

-- CreateIndex
CREATE INDEX "affiliate_post_snapshots_postId_capturedAt_idx" ON "affiliate_post_snapshots"("postId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_commissions_source_contentRunId_affiliateId_key" ON "affiliate_commissions"("source", "contentRunId", "affiliateId");
