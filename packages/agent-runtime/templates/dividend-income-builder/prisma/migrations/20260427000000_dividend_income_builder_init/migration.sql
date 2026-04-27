-- CreateTable
CREATE TABLE "dividend_candidates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "yieldText" TEXT NOT NULL,
    "safetyScore" INTEGER NOT NULL DEFAULT 0,
    "growthStreak" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "dividend_portfolios" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "capitalAmount" TEXT NOT NULL,
    "incomeGoal" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "riskProfile" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "income_projections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "period" TEXT NOT NULL,
    "expectedIncome" TEXT NOT NULL,
    "targetIncome" TEXT NOT NULL,
    "gap" TEXT NOT NULL,
    "assumptions" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "dividend_safety_checks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "payoutRatio" TEXT NOT NULL,
    "debtNote" TEXT NOT NULL,
    "coverageNote" TEXT NOT NULL,
    "riskFlag" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "reinvestment_scenarios" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "horizonYears" INTEGER NOT NULL DEFAULT 0,
    "startingCapital" TEXT NOT NULL,
    "assumedGrowth" TEXT NOT NULL,
    "projectedIncome" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "tax_notes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountType" TEXT NOT NULL,
    "dividendType" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "questionForAdvisor" TEXT NOT NULL,
    "updatedAtText" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "dividend_candidates_ticker_idx" ON "dividend_candidates"("ticker");

-- CreateIndex
CREATE INDEX "dividend_portfolios_name_idx" ON "dividend_portfolios"("name");

-- CreateIndex
CREATE INDEX "income_projections_period_idx" ON "income_projections"("period");

-- CreateIndex
CREATE INDEX "dividend_safety_checks_ticker_idx" ON "dividend_safety_checks"("ticker");

-- CreateIndex
CREATE INDEX "reinvestment_scenarios_name_idx" ON "reinvestment_scenarios"("name");
