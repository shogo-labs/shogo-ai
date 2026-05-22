-- Migration: create marketplace + creator-economy tables (SQLite mirror of
-- prisma/migrations/20260407120000_add_marketplace_tables/migration.sql).
--
-- The cloud PG track has shipped marketplace tables since 20260407, but the
-- desktop SQLite track only inherited the *follow-up* migrations
-- (20260516000000_marketplace_versioning_audit and
-- 20260516120000_marketplace_snapshot_s3) without the base CREATE TABLEs.
-- That left every existing local DB hitting `no such table:
-- marketplace_installs` on the 20260516000000 ALTER, marking the migration
-- as failed and tripping Prisma's P3009 lock on every subsequent launch
-- (i.e. the desktop app silently refusing to open).
--
-- This migration backfills the missing base schema. It's ordered to run
-- BEFORE 20260516000000_marketplace_versioning_audit so the audit ALTERs
-- have something to attach to. Existing installs whose audit migration is
-- already recorded as failed should mark it rolled back first:
--
--   bunx prisma migrate resolve \
--     --rolled-back 20260516000000_marketplace_versioning_audit
--
-- IDEMPOTENT (CREATE … IF NOT EXISTS everywhere):
--   The v1.8.2 release of this file used plain CREATE TABLE / CREATE INDEX
--   and broke every user whose seed.db already contained the marketplace
--   schema. seed.db is generated at build time by
--   apps/desktop/scripts/bundle-api.mjs via
--   `prisma db push --schema=prisma/schema.local.prisma`, which has
--   materialised the marketplace models since commit 2286a52b
--   ("marketplacev0.1", 2026-04-08). For those users the CREATE TABLE
--   fails with `table already exists`, leaves the migration recorded as
--   failed in _prisma_migrations, and the desktop app sits in the
--   DatabaseRecoveryError dialog on every relaunch — Repair clears the
--   row but the next deploy hits the same collision. Making every DDL
--   here `IF NOT EXISTS` turns the migration into a no-op for
--   seed-baselined DBs while still doing the real CREATEs on the original
--   target audience (DBs that pre-date marketplacev0.1 and genuinely
--   lack these tables).
--
-- SQLite notes vs the PG source:
--   * Enums (PayoutStatus, CreatorTier, BadgeType, PricingModel,
--     InstallModel, ListingStatus, InstallStatus, TransactionType,
--     TransactionStatus) → TEXT columns. The application layer enforces
--     allowed values.
--   * TEXT[] (tags, screenshotUrls) → TEXT defaulting to '[]', JSON-encoded.
--   * JSONB (metadata, workspaceSnapshot) → TEXT, JSON-encoded.
--   * DOUBLE PRECISION → REAL.
--   * No DESC modifier on indexes — SQLite ignores it anyway for ordered
--     scans on these column types, so we drop it for clarity.

PRAGMA foreign_keys = OFF;

-- ─── creator_profiles ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "creator_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "websiteUrl" TEXT,
    "stripeCustomAccountId" TEXT,
    "payoutStatus" TEXT NOT NULL DEFAULT 'not_setup',
    "payoutDetailsSubmittedAt" DATETIME,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "totalEarningsInCents" INTEGER NOT NULL DEFAULT 0,
    "pendingPayoutInCents" INTEGER NOT NULL DEFAULT 0,
    "totalPaidOutInCents" INTEGER NOT NULL DEFAULT 0,
    "creatorTier" TEXT NOT NULL DEFAULT 'newcomer',
    "reputationScore" INTEGER NOT NULL DEFAULT 0,
    "totalAgentsPublished" INTEGER NOT NULL DEFAULT 0,
    "totalInstalls" INTEGER NOT NULL DEFAULT 0,
    "averageAgentRating" REAL NOT NULL DEFAULT 0,
    "totalVersionsShipped" INTEGER NOT NULL DEFAULT 0,
    "activeMaintenanceStreak" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "creator_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "creator_profiles_userId_key" ON "creator_profiles"("userId");
CREATE INDEX IF NOT EXISTS "creator_profiles_creatorTier_idx" ON "creator_profiles"("creatorTier");
CREATE INDEX IF NOT EXISTS "creator_profiles_reputationScore_idx" ON "creator_profiles"("reputationScore");

-- ─── creator_badges ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "creator_badges" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "creatorId" TEXT NOT NULL,
    "badgeType" TEXT NOT NULL,
    "earnedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" TEXT,
    CONSTRAINT "creator_badges_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "creator_badges_creatorId_badgeType_key" ON "creator_badges"("creatorId", "badgeType");
CREATE INDEX IF NOT EXISTS "creator_badges_creatorId_idx" ON "creator_badges"("creatorId");

-- ─── marketplace_listings ─────────────────────────────────────────────────
-- The Phase 7 admin-review columns (rejectionReason, reviewedAt, reviewedBy)
-- are added separately by 20260516000000_marketplace_versioning_audit — we
-- omit them here so the subsequent ALTER doesn't hit a duplicate-column
-- error.
CREATE TABLE IF NOT EXISTS "marketplace_listings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "shortDescription" TEXT NOT NULL,
    "longDescription" TEXT,
    "category" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "iconUrl" TEXT,
    "screenshotUrls" TEXT NOT NULL DEFAULT '[]',
    "pricingModel" TEXT NOT NULL DEFAULT 'free',
    "priceInCents" INTEGER,
    "monthlyPriceInCents" INTEGER,
    "annualPriceInCents" INTEGER,
    "installModel" TEXT NOT NULL DEFAULT 'fork',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currentVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "stripePriceId" TEXT,
    "stripeMonthlyPriceId" TEXT,
    "stripeAnnualPriceId" TEXT,
    "installCount" INTEGER NOT NULL DEFAULT 0,
    "averageRating" REAL NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" DATETIME,
    "featuredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "marketplace_listings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "marketplace_listings_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_listings_projectId_key" ON "marketplace_listings"("projectId");
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_listings_slug_key" ON "marketplace_listings"("slug");
CREATE INDEX IF NOT EXISTS "marketplace_listings_creatorId_idx" ON "marketplace_listings"("creatorId");
CREATE INDEX IF NOT EXISTS "marketplace_listings_status_idx" ON "marketplace_listings"("status");
CREATE INDEX IF NOT EXISTS "marketplace_listings_category_idx" ON "marketplace_listings"("category");
CREATE INDEX IF NOT EXISTS "marketplace_listings_pricingModel_idx" ON "marketplace_listings"("pricingModel");
CREATE INDEX IF NOT EXISTS "marketplace_listings_installCount_idx" ON "marketplace_listings"("installCount");
CREATE INDEX IF NOT EXISTS "marketplace_listings_averageRating_idx" ON "marketplace_listings"("averageRating");
CREATE INDEX IF NOT EXISTS "marketplace_listings_publishedAt_idx" ON "marketplace_listings"("publishedAt");

-- ─── marketplace_listing_versions ─────────────────────────────────────────
-- The Phase 7 audit columns (auditStatus, auditedAt, auditedBy,
-- auditFindings, auditModel) are added by 20260516000000; the S3 snapshot
-- columns (workspaceSnapshotKey/Bytes/Checksum) are added by
-- 20260516120000. We create only the original PG-era columns here.
CREATE TABLE IF NOT EXISTS "marketplace_listing_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listingId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "changelog" TEXT,
    "workspaceSnapshot" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "marketplace_listing_versions_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_listing_versions_listingId_version_key" ON "marketplace_listing_versions"("listingId", "version");
CREATE INDEX IF NOT EXISTS "marketplace_listing_versions_listingId_idx" ON "marketplace_listing_versions"("listingId");

-- ─── marketplace_installs ─────────────────────────────────────────────────
-- The Phase 6 drift-detection column (baselineManifest) is added by
-- 20260516000000_marketplace_versioning_audit — omit it here.
CREATE TABLE IF NOT EXISTS "marketplace_installs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listingId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "installModel" TEXT NOT NULL,
    "installedVersion" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "marketplace_installs_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "marketplace_installs_listingId_idx" ON "marketplace_installs"("listingId");
CREATE INDEX IF NOT EXISTS "marketplace_installs_userId_idx" ON "marketplace_installs"("userId");
CREATE INDEX IF NOT EXISTS "marketplace_installs_workspaceId_idx" ON "marketplace_installs"("workspaceId");
CREATE INDEX IF NOT EXISTS "marketplace_installs_projectId_idx" ON "marketplace_installs"("projectId");

-- ─── marketplace_reviews ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "marketplace_reviews" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "installId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "marketplace_reviews_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "marketplace_reviews_installId_fkey" FOREIGN KEY ("installId") REFERENCES "marketplace_installs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_reviews_listingId_userId_key" ON "marketplace_reviews"("listingId", "userId");
CREATE INDEX IF NOT EXISTS "marketplace_reviews_listingId_idx" ON "marketplace_reviews"("listingId");
CREATE INDEX IF NOT EXISTS "marketplace_reviews_userId_idx" ON "marketplace_reviews"("userId");

-- ─── marketplace_transactions ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "marketplace_transactions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listingId" TEXT NOT NULL,
    "installId" TEXT,
    "buyerUserId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountInCents" INTEGER NOT NULL,
    "platformFeeInCents" INTEGER NOT NULL,
    "creatorAmountInCents" INTEGER NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeTransferId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "marketplace_transactions_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "marketplace_transactions_installId_fkey" FOREIGN KEY ("installId") REFERENCES "marketplace_installs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "marketplace_transactions_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "marketplace_transactions_listingId_idx" ON "marketplace_transactions"("listingId");
CREATE INDEX IF NOT EXISTS "marketplace_transactions_creatorId_idx" ON "marketplace_transactions"("creatorId");
CREATE INDEX IF NOT EXISTS "marketplace_transactions_buyerUserId_idx" ON "marketplace_transactions"("buyerUserId");
CREATE INDEX IF NOT EXISTS "marketplace_transactions_status_idx" ON "marketplace_transactions"("status");
CREATE INDEX IF NOT EXISTS "marketplace_transactions_createdAt_idx" ON "marketplace_transactions"("createdAt");

PRAGMA foreign_keys = ON;
