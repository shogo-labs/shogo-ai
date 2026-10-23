-- AlterEnum
ALTER TYPE "UsageSource" ADD VALUE 'promo';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "emailCanonical" TEXT;

-- AlterTable
ALTER TABLE "usage_wallets" ADD COLUMN     "promoCreditExpiresAt" TIMESTAMP(3),
ADD COLUMN     "promoCreditGrantedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "promoCreditStage" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promoCreditUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "signup_risk_assessments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "band" TEXT NOT NULL,
    "signals" JSONB NOT NULL,
    "decision" TEXT NOT NULL,
    "ip" TEXT,
    "ipPrefix" TEXT,
    "country" TEXT,
    "deviceId" TEXT,
    "emailCanonical" TEXT,
    "reviewDecision" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signup_risk_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trial_redemptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT,
    "cardFingerprint" TEXT,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trial_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signup_risk_assessments_userId_key" ON "signup_risk_assessments"("userId");

-- CreateIndex
CREATE INDEX "signup_risk_assessments_ipPrefix_createdAt_idx" ON "signup_risk_assessments"("ipPrefix", "createdAt");

-- CreateIndex
CREATE INDEX "signup_risk_assessments_deviceId_createdAt_idx" ON "signup_risk_assessments"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "signup_risk_assessments_emailCanonical_idx" ON "signup_risk_assessments"("emailCanonical");

-- CreateIndex
CREATE INDEX "signup_risk_assessments_band_createdAt_idx" ON "signup_risk_assessments"("band", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "trial_redemptions_workspaceId_key" ON "trial_redemptions"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "trial_redemptions_cardFingerprint_key" ON "trial_redemptions"("cardFingerprint");

-- CreateIndex
CREATE INDEX "trial_redemptions_userId_idx" ON "trial_redemptions"("userId");

-- CreateIndex
CREATE INDEX "users_emailCanonical_idx" ON "users"("emailCanonical");

-- Backfill emailCanonical for existing users (same rules as lib/email-canonical.ts):
-- Gmail/Googlemail: dots and +tag removed, domain normalized to gmail.com.
-- Others: +tag removed, domain kept.
UPDATE "users"
SET "emailCanonical" = CASE
  WHEN lower(split_part("email", '@', 2)) IN ('gmail.com', 'googlemail.com')
    THEN replace(split_part(lower(split_part("email", '@', 1)), '+', 1), '.', '') || '@gmail.com'
  ELSE split_part(lower(split_part("email", '@', 1)), '+', 1) || '@' || lower(split_part("email", '@', 2))
END
WHERE "emailCanonical" IS NULL AND "email" LIKE '%@%';
