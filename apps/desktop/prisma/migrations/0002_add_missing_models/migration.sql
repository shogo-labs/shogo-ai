-- DropIndex
DROP INDEX IF EXISTS "subscriptions_workspaceId_idx";

-- AlterTable
ALTER TABLE "agent_configs" ADD COLUMN "lastHeartbeatAt" DATETIME;
ALTER TABLE "agent_configs" ADD COLUMN "quietHoursEnd" TEXT;
ALTER TABLE "agent_configs" ADD COLUMN "quietHoursStart" TEXT;
ALTER TABLE "agent_configs" ADD COLUMN "quietHoursTimezone" TEXT;

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "api_keys_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "instances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "os" TEXT,
    "arch" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastSeenAt" DATETIME,
    "wsRequestedAt" DATETIME,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "instances_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "eval_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "track" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "workers" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "label" TEXT,
    "tags" TEXT,
    "triggeredBy" TEXT,
    "pid" INTEGER,
    "jobName" TEXT,
    "error" TEXT,
    "summary" TEXT,
    "cost" TEXT,
    "byCategory" TEXT,
    "resources" TEXT,
    "progress" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "eval_run_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "evalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "level" INTEGER,
    "passed" BOOLEAN NOT NULL,
    "score" INTEGER NOT NULL,
    "maxScore" INTEGER NOT NULL,
    "percentage" REAL NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "tokens" TEXT,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "failedToolCalls" INTEGER NOT NULL DEFAULT 0,
    "iterations" INTEGER NOT NULL DEFAULT 0,
    "phaseScores" TEXT,
    "pipeline" TEXT,
    "pipelinePhase" INTEGER,
    "criteria" TEXT,
    "antiPatterns" TEXT,
    "errors" TEXT,
    "warnings" TEXT,
    "log" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "eval_run_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "eval_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables (add contextUsageTokens, contextWindowTokens to chat_sessions)
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_chat_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "inferredName" TEXT NOT NULL,
    "contextType" TEXT NOT NULL,
    "contextId" TEXT,
    "phase" TEXT,
    "claudeCodeSessionId" TEXT,
    "cachedMessageCount" INTEGER NOT NULL DEFAULT 0,
    "contextUsageTokens" INTEGER NOT NULL DEFAULT 0,
    "contextWindowTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_sessions_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_chat_sessions" ("cachedMessageCount", "claudeCodeSessionId", "contextId", "contextType", "createdAt", "id", "inferredName", "lastActiveAt", "name", "phase", "updatedAt") SELECT "cachedMessageCount", "claudeCodeSessionId", "contextId", "contextType", "createdAt", "id", "inferredName", "lastActiveAt", "name", "phase", "updatedAt" FROM "chat_sessions";
DROP TABLE "chat_sessions";
ALTER TABLE "new_chat_sessions" RENAME TO "chat_sessions";
CREATE INDEX "chat_sessions_contextType_contextId_idx" ON "chat_sessions"("contextType", "contextId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_workspaceId_idx" ON "api_keys"("workspaceId");

-- CreateIndex
CREATE INDEX "api_keys_userId_idx" ON "api_keys"("userId");

-- CreateIndex
CREATE INDEX "instances_workspaceId_idx" ON "instances"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "instances_workspaceId_hostname_key" ON "instances"("workspaceId", "hostname");

-- CreateIndex
CREATE INDEX "eval_runs_status_idx" ON "eval_runs"("status");

-- CreateIndex
CREATE INDEX "eval_runs_createdAt_idx" ON "eval_runs"("createdAt");

-- CreateIndex
CREATE INDEX "eval_run_results_runId_idx" ON "eval_run_results"("runId");

-- CreateIndex
CREATE INDEX "eval_run_results_evalId_idx" ON "eval_run_results"("evalId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_workspaceId_key" ON "subscriptions"("workspaceId");

-- CreateTable
CREATE TABLE "analytics_digests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "period" TEXT NOT NULL DEFAULT '24h',
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
    "totalCreditsUsed" REAL NOT NULL DEFAULT 0,
    "templateStats" TEXT,
    "chunksProcessed" INTEGER NOT NULL DEFAULT 1,
    "messagesAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "aiInsights" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "analytics_digests_date_period_key" ON "analytics_digests"("date", "period");
