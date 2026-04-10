-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('not_setup', 'pending_verification', 'verified', 'requires_update', 'disabled');

-- CreateEnum
CREATE TYPE "CreatorTier" AS ENUM ('newcomer', 'builder', 'craftsman', 'expert', 'master');

-- CreateEnum
CREATE TYPE "BadgeType" AS ENUM ('first_agent', 'popular_10', 'popular_100', 'popular_1000', 'top_rated', 'five_star', 'prolific_builder', 'master_builder', 'active_maintainer', 'streak_3', 'streak_6', 'streak_12', 'multi_category', 'early_adopter', 'verified_creator');

-- CreateEnum
CREATE TYPE "PricingModel" AS ENUM ('free', 'one_time', 'subscription');

-- CreateEnum
CREATE TYPE "InstallModel" AS ENUM ('fork', 'linked');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('draft', 'in_review', 'published', 'suspended', 'archived');

-- CreateEnum
CREATE TYPE "InstallStatus" AS ENUM ('active', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('purchase', 'subscription_payment', 'refund');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('pending', 'completed', 'failed', 'refunded');

-- CreateTable
CREATE TABLE "creator_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "websiteUrl" TEXT,
    "stripeCustomAccountId" TEXT,
    "payoutStatus" "PayoutStatus" NOT NULL DEFAULT 'not_setup',
    "payoutDetailsSubmittedAt" TIMESTAMP(3),
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "totalEarningsInCents" INTEGER NOT NULL DEFAULT 0,
    "pendingPayoutInCents" INTEGER NOT NULL DEFAULT 0,
    "totalPaidOutInCents" INTEGER NOT NULL DEFAULT 0,
    "creatorTier" "CreatorTier" NOT NULL DEFAULT 'newcomer',
    "reputationScore" INTEGER NOT NULL DEFAULT 0,
    "totalAgentsPublished" INTEGER NOT NULL DEFAULT 0,
    "totalInstalls" INTEGER NOT NULL DEFAULT 0,
    "averageAgentRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalVersionsShipped" INTEGER NOT NULL DEFAULT 0,
    "activeMaintenanceStreak" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_badges" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "badgeType" "BadgeType" NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "creator_badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_listings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "shortDescription" TEXT NOT NULL,
    "longDescription" TEXT,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "iconUrl" TEXT,
    "screenshotUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pricingModel" "PricingModel" NOT NULL DEFAULT 'free',
    "priceInCents" INTEGER,
    "monthlyPriceInCents" INTEGER,
    "annualPriceInCents" INTEGER,
    "installModel" "InstallModel" NOT NULL DEFAULT 'fork',
    "status" "ListingStatus" NOT NULL DEFAULT 'draft',
    "currentVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "stripePriceId" TEXT,
    "stripeMonthlyPriceId" TEXT,
    "stripeAnnualPriceId" TEXT,
    "installCount" INTEGER NOT NULL DEFAULT 0,
    "averageRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "featuredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_listing_versions" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "changelog" TEXT,
    "workspaceSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_listing_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_installs" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "installModel" "InstallModel" NOT NULL,
    "installedVersion" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT,
    "status" "InstallStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_installs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_reviews" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "installId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_transactions" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "installId" TEXT,
    "buyerUserId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amountInCents" INTEGER NOT NULL,
    "platformFeeInCents" INTEGER NOT NULL,
    "creatorAmountInCents" INTEGER NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeTransferId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "TransactionStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "creator_profiles_userId_key" ON "creator_profiles"("userId");
CREATE INDEX "creator_profiles_creatorTier_idx" ON "creator_profiles"("creatorTier");
CREATE INDEX "creator_profiles_reputationScore_idx" ON "creator_profiles"("reputationScore" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "creator_badges_creatorId_badgeType_key" ON "creator_badges"("creatorId", "badgeType");
CREATE INDEX "creator_badges_creatorId_idx" ON "creator_badges"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_projectId_key" ON "marketplace_listings"("projectId");
CREATE UNIQUE INDEX "marketplace_listings_slug_key" ON "marketplace_listings"("slug");
CREATE INDEX "marketplace_listings_creatorId_idx" ON "marketplace_listings"("creatorId");
CREATE INDEX "marketplace_listings_status_idx" ON "marketplace_listings"("status");
CREATE INDEX "marketplace_listings_category_idx" ON "marketplace_listings"("category");
CREATE INDEX "marketplace_listings_pricingModel_idx" ON "marketplace_listings"("pricingModel");
CREATE INDEX "marketplace_listings_installCount_idx" ON "marketplace_listings"("installCount" DESC);
CREATE INDEX "marketplace_listings_averageRating_idx" ON "marketplace_listings"("averageRating" DESC);
CREATE INDEX "marketplace_listings_publishedAt_idx" ON "marketplace_listings"("publishedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listing_versions_listingId_version_key" ON "marketplace_listing_versions"("listingId", "version");
CREATE INDEX "marketplace_listing_versions_listingId_idx" ON "marketplace_listing_versions"("listingId");

-- CreateIndex
CREATE INDEX "marketplace_installs_listingId_idx" ON "marketplace_installs"("listingId");
CREATE INDEX "marketplace_installs_userId_idx" ON "marketplace_installs"("userId");
CREATE INDEX "marketplace_installs_workspaceId_idx" ON "marketplace_installs"("workspaceId");
CREATE INDEX "marketplace_installs_projectId_idx" ON "marketplace_installs"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_reviews_listingId_userId_key" ON "marketplace_reviews"("listingId", "userId");
CREATE INDEX "marketplace_reviews_listingId_idx" ON "marketplace_reviews"("listingId");
CREATE INDEX "marketplace_reviews_userId_idx" ON "marketplace_reviews"("userId");

-- CreateIndex
CREATE INDEX "marketplace_transactions_listingId_idx" ON "marketplace_transactions"("listingId");
CREATE INDEX "marketplace_transactions_creatorId_idx" ON "marketplace_transactions"("creatorId");
CREATE INDEX "marketplace_transactions_buyerUserId_idx" ON "marketplace_transactions"("buyerUserId");
CREATE INDEX "marketplace_transactions_status_idx" ON "marketplace_transactions"("status");
CREATE INDEX "marketplace_transactions_createdAt_idx" ON "marketplace_transactions"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_badges" ADD CONSTRAINT "creator_badges_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listing_versions" ADD CONSTRAINT "marketplace_listing_versions_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_installs" ADD CONSTRAINT "marketplace_installs_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_reviews" ADD CONSTRAINT "marketplace_reviews_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_reviews" ADD CONSTRAINT "marketplace_reviews_installId_fkey" FOREIGN KEY ("installId") REFERENCES "marketplace_installs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_transactions" ADD CONSTRAINT "marketplace_transactions_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_transactions" ADD CONSTRAINT "marketplace_transactions_installId_fkey" FOREIGN KEY ("installId") REFERENCES "marketplace_installs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_transactions" ADD CONSTRAINT "marketplace_transactions_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
