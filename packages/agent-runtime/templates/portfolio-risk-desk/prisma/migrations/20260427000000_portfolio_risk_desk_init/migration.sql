-- CreateTable
CREATE TABLE "holdings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weight" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "liquidityRating" TEXT NOT NULL,
    "riskNote" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "portfolio_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "asOfDate" TEXT NOT NULL,
    "totalValue" TEXT NOT NULL,
    "cashWeight" TEXT NOT NULL,
    "topRisk" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "risk_scenarios" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "probability" TEXT NOT NULL,
    "estimatedDrawdown" TEXT NOT NULL,
    "affectedHoldings" TEXT NOT NULL,
    "mitigation" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "correlation_observations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "holdingA" TEXT NOT NULL,
    "holdingB" TEXT NOT NULL,
    "correlation" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "interpretation" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "allocation_targets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetClass" TEXT NOT NULL,
    "targetWeight" TEXT NOT NULL,
    "currentWeight" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "benchmark" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "rebalance_actions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "targetWeight" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "macro_assumptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "driver" TEXT NOT NULL,
    "baseCase" TEXT NOT NULL,
    "portfolioImpact" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "reviewDate" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "holdings_ticker_idx" ON "holdings"("ticker");

-- CreateIndex
CREATE INDEX "portfolio_snapshots_asOfDate_idx" ON "portfolio_snapshots"("asOfDate");

-- CreateIndex
CREATE INDEX "risk_scenarios_name_idx" ON "risk_scenarios"("name");

-- CreateIndex
CREATE INDEX "correlation_observations_period_idx" ON "correlation_observations"("period");

-- CreateIndex
CREATE INDEX "rebalance_actions_ticker_idx" ON "rebalance_actions"("ticker");
