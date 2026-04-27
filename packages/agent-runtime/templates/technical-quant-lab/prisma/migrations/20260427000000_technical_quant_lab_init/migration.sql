-- CreateTable
CREATE TABLE "ticker_setups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "bias" TEXT NOT NULL,
    "currentPosition" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "indicator_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "trend" TEXT NOT NULL,
    "rsi" TEXT NOT NULL,
    "macd" TEXT NOT NULL,
    "movingAverages" TEXT NOT NULL,
    "volumeSignal" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "support_resistance_levels" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "levelType" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "pattern_signals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "event_patterns" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "historicalBehavior" TEXT NOT NULL,
    "edgeSummary" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "options_signals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "expiry" TEXT NOT NULL,
    "strikeContext" TEXT NOT NULL,
    "interpretation" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "trade_plans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "entryZone" TEXT NOT NULL,
    "stopLoss" TEXT NOT NULL,
    "profitTarget" TEXT NOT NULL,
    "riskReward" TEXT NOT NULL,
    "invalidation" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ticker_setups_ticker_idx" ON "ticker_setups"("ticker");

-- CreateIndex
CREATE INDEX "indicator_snapshots_ticker_idx" ON "indicator_snapshots"("ticker");

-- CreateIndex
CREATE INDEX "support_resistance_levels_ticker_idx" ON "support_resistance_levels"("ticker");

-- CreateIndex
CREATE INDEX "pattern_signals_ticker_idx" ON "pattern_signals"("ticker");

-- CreateIndex
CREATE INDEX "event_patterns_ticker_idx" ON "event_patterns"("ticker");

-- CreateIndex
CREATE INDEX "options_signals_ticker_idx" ON "options_signals"("ticker");

-- CreateIndex
CREATE INDEX "trade_plans_ticker_idx" ON "trade_plans"("ticker");
