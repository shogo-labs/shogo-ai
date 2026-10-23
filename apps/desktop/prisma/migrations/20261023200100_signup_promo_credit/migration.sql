-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_usage_wallets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "monthlyIncludedUsd" REAL NOT NULL DEFAULT 0,
    "dailyIncludedUsd" REAL NOT NULL DEFAULT 0,
    "monthlyIncludedAllocationUsd" REAL NOT NULL DEFAULT 0,
    "dailyUsedThisMonthUsd" REAL NOT NULL DEFAULT 0,
    "overageEnabled" BOOLEAN NOT NULL DEFAULT true,
    "overageHardLimitUsd" REAL,
    "overageAccumulatedUsd" REAL NOT NULL DEFAULT 0,
    "overageBilledUsd" REAL NOT NULL DEFAULT 0,
    "overagePaidBlocks" INTEGER NOT NULL DEFAULT 0,
    "overageOutstandingInvoiceId" TEXT,
    "overageOutstandingUsd" REAL NOT NULL DEFAULT 0,
    "overageOutstandingInvoiceUrl" TEXT,
    "alertsSentThisPeriod" TEXT,
    "stripeMeteredItemId" TEXT,
    "anniversaryDay" INTEGER NOT NULL,
    "lastDailyReset" DATETIME NOT NULL,
    "lastMonthlyReset" DATETIME NOT NULL,
    "fiveHourWindowStart" DATETIME,
    "fiveHourUsedUsd" REAL NOT NULL DEFAULT 0,
    "weeklyWindowStart" DATETIME,
    "weeklyUsedUsd" REAL NOT NULL DEFAULT 0,
    "promoCreditUsd" REAL NOT NULL DEFAULT 0,
    "promoCreditGrantedUsd" REAL NOT NULL DEFAULT 0,
    "promoCreditExpiresAt" DATETIME,
    "promoCreditStage" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "usage_wallets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_usage_wallets" ("alertsSentThisPeriod", "anniversaryDay", "createdAt", "dailyIncludedUsd", "dailyUsedThisMonthUsd", "fiveHourUsedUsd", "fiveHourWindowStart", "id", "lastDailyReset", "lastMonthlyReset", "monthlyIncludedAllocationUsd", "monthlyIncludedUsd", "overageAccumulatedUsd", "overageBilledUsd", "overageEnabled", "overageHardLimitUsd", "overageOutstandingInvoiceId", "overageOutstandingInvoiceUrl", "overageOutstandingUsd", "overagePaidBlocks", "stripeMeteredItemId", "updatedAt", "weeklyUsedUsd", "weeklyWindowStart", "workspaceId") SELECT "alertsSentThisPeriod", "anniversaryDay", "createdAt", "dailyIncludedUsd", "dailyUsedThisMonthUsd", "fiveHourUsedUsd", "fiveHourWindowStart", "id", "lastDailyReset", "lastMonthlyReset", "monthlyIncludedAllocationUsd", "monthlyIncludedUsd", "overageAccumulatedUsd", "overageBilledUsd", "overageEnabled", "overageHardLimitUsd", "overageOutstandingInvoiceId", "overageOutstandingInvoiceUrl", "overageOutstandingUsd", "overagePaidBlocks", "stripeMeteredItemId", "updatedAt", "weeklyUsedUsd", "weeklyWindowStart", "workspaceId" FROM "usage_wallets";
DROP TABLE "usage_wallets";
ALTER TABLE "new_usage_wallets" RENAME TO "usage_wallets";
CREATE UNIQUE INDEX "usage_wallets_workspaceId_key" ON "usage_wallets"("workspaceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
