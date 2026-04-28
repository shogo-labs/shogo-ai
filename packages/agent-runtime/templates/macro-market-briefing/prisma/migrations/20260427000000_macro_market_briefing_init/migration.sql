-- CreateTable
CREATE TABLE "macro_indicators" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "latestReading" TEXT NOT NULL,
    "trend" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "marketImplication" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "policy_outlooks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "institution" TEXT NOT NULL,
    "baseCase" TEXT NOT NULL,
    "nextMeeting" TEXT NOT NULL,
    "ratePath" TEXT NOT NULL,
    "riskToView" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sector_views" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sector" TEXT NOT NULL,
    "stance" TEXT NOT NULL,
    "cycleRationale" TEXT NOT NULL,
    "benefitsFrom" TEXT NOT NULL,
    "watchItem" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "global_risks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "probability" TEXT NOT NULL,
    "marketChannel" TEXT NOT NULL,
    "timeline" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "portfolio_impacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "holdingOrSector" TEXT NOT NULL,
    "macroDriver" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "action_plans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "briefings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "keyRisks" TEXT NOT NULL,
    "recommendedActions" TEXT NOT NULL,
    "asOfDate" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "macro_indicators_name_idx" ON "macro_indicators"("name");

-- CreateIndex
CREATE INDEX "sector_views_sector_idx" ON "sector_views"("sector");

-- CreateIndex
CREATE INDEX "global_risks_name_idx" ON "global_risks"("name");

-- CreateIndex
CREATE INDEX "action_plans_status_idx" ON "action_plans"("status");

-- CreateIndex
CREATE INDEX "briefings_asOfDate_idx" ON "briefings"("asOfDate");
