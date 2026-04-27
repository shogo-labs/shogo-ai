-- CreateTable
CREATE TABLE "stock_watchlists" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "thesis" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "stock_screens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "criteria" TEXT NOT NULL,
    "topTickers" TEXT NOT NULL,
    "riskRating" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "equity_reports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "bullCase" TEXT NOT NULL,
    "bearCase" TEXT NOT NULL,
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "valuation_models" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "fairValueRange" TEXT NOT NULL,
    "wacc" TEXT NOT NULL,
    "terminalAssumption" TEXT NOT NULL,
    "keyRisk" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "competitive_sets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sector" TEXT NOT NULL,
    "leaderTicker" TEXT NOT NULL,
    "peerTickers" TEXT NOT NULL,
    "moatSummary" TEXT NOT NULL,
    "catalyst" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "earnings_notes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "takeaways" TEXT NOT NULL,
    "openQuestions" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "source_citations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "relatedTicker" TEXT NOT NULL,
    "sourceTitle" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "publishedAt" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "stock_watchlists_ticker_idx" ON "stock_watchlists"("ticker");

-- CreateIndex
CREATE INDEX "stock_screens_name_idx" ON "stock_screens"("name");

-- CreateIndex
CREATE INDEX "equity_reports_ticker_idx" ON "equity_reports"("ticker");

-- CreateIndex
CREATE INDEX "valuation_models_ticker_idx" ON "valuation_models"("ticker");

-- CreateIndex
CREATE INDEX "competitive_sets_sector_idx" ON "competitive_sets"("sector");

-- CreateIndex
CREATE INDEX "earnings_notes_ticker_idx" ON "earnings_notes"("ticker");
