-- Migration: make_analytics_digest_region_required
-- Generated: 2026-05-21T19:37:24Z by scripts/db-migrate-desktop.ts, then
-- TRIMMED by hand to only contain the analytics_digests changes.
--
-- The raw `prisma migrate diff` output for this change also included
-- RedefineTables for the same ~9 ACCEPTED_DRIFT tables documented in
-- scripts/check-desktop-schema-drift.ts (agent_configs, agent_eval_sets,
-- budget_alerts, eval_runs, model_experiments, projects,
-- signup_attributions, subagent_model_overrides, usage_wallets,
-- workspace_grants). Those are intentionally not corrected here for
-- the same reason as the earlier 20260521000000 add-region migration.
--
-- SQLite doesn't support `ALTER COLUMN ... SET NOT NULL`, so Prisma's
-- SQLite SQL generator emits the standard SQLite redefine-table
-- pattern: CREATE new with NOT NULL, copy data via INSERT ... SELECT,
-- DROP old, RENAME new. Existing data is preserved by the SELECT step.
-- Any desktop install that still has a NULL row in analytics_digests
-- when this migration runs will fail at the INSERT step on the NOT
-- NULL constraint — but desktop only writes single-region digests so
-- there should be no NULLs in practice (and if there are, deleting
-- them is the right answer since they were never tagged).

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_analytics_digests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "period" TEXT NOT NULL DEFAULT '24h',
    "region" TEXT NOT NULL,
    "funnelSignups" INTEGER NOT NULL DEFAULT 0,
    "funnelOnboarded" INTEGER NOT NULL DEFAULT 0,
    "funnelCreatedProject" INTEGER NOT NULL DEFAULT 0,
    "funnelSentMessage" INTEGER NOT NULL DEFAULT 0,
    "funnelEngaged" INTEGER NOT NULL DEFAULT 0,
    "avgMinToFirstProject" REAL,
    "avgMinToFirstMessage" REAL,
    "activeUsers" INTEGER NOT NULL DEFAULT 0,
    "totalMessages" INTEGER NOT NULL DEFAULT 0,
    "totalSessions" INTEGER NOT NULL DEFAULT 0,
    "totalToolCalls" INTEGER NOT NULL DEFAULT 0,
    "totalSpendUsd" REAL NOT NULL DEFAULT 0,
    "templateStats" TEXT,
    "chunksProcessed" INTEGER NOT NULL DEFAULT 1,
    "messagesAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "aiInsights" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_analytics_digests" ("activeUsers", "aiInsights", "avgMinToFirstMessage", "avgMinToFirstProject", "chunksProcessed", "createdAt", "date", "funnelCreatedProject", "funnelEngaged", "funnelOnboarded", "funnelSentMessage", "funnelSignups", "id", "messagesAnalyzed", "period", "region", "templateStats", "totalMessages", "totalSessions", "totalSpendUsd", "totalToolCalls") SELECT "activeUsers", "aiInsights", "avgMinToFirstMessage", "avgMinToFirstProject", "chunksProcessed", "createdAt", "date", "funnelCreatedProject", "funnelEngaged", "funnelOnboarded", "funnelSentMessage", "funnelSignups", "id", "messagesAnalyzed", "period", "region", "templateStats", "totalMessages", "totalSessions", "totalSpendUsd", "totalToolCalls" FROM "analytics_digests";
DROP TABLE "analytics_digests";
ALTER TABLE "new_analytics_digests" RENAME TO "analytics_digests";
CREATE UNIQUE INDEX "analytics_digests_date_period_region_key" ON "analytics_digests"("date", "period", "region");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
