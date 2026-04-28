-- SQLite local-mode support for the Agent Cost Optimizer.
-- Mirrors the Postgres cost analytics tables with SQLite-compatible types.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS "agent_cost_metrics" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "projectId" TEXT,
  "agentRunId" TEXT,
  "agentType" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
  "toolCalls" INTEGER NOT NULL DEFAULT 0,
  "creditCost" REAL NOT NULL DEFAULT 0,
  "wallTimeMs" INTEGER NOT NULL DEFAULT 0,
  "success" BOOLEAN NOT NULL DEFAULT true,
  "hitMaxTurns" BOOLEAN NOT NULL DEFAULT false,
  "loopDetected" BOOLEAN NOT NULL DEFAULT false,
  "escalated" BOOLEAN NOT NULL DEFAULT false,
  "responseEmpty" BOOLEAN NOT NULL DEFAULT false,
  "userFeedback" TEXT,
  "metadata" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_cost_metrics_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_cost_metrics_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_cost_metrics_agentRunId_key"
  ON "agent_cost_metrics"("agentRunId");
CREATE INDEX IF NOT EXISTS "agent_cost_metrics_workspaceId_idx"
  ON "agent_cost_metrics"("workspaceId");
CREATE INDEX IF NOT EXISTS "agent_cost_metrics_projectId_idx"
  ON "agent_cost_metrics"("projectId");
CREATE INDEX IF NOT EXISTS "agent_cost_metrics_agentType_idx"
  ON "agent_cost_metrics"("agentType");
CREATE INDEX IF NOT EXISTS "agent_cost_metrics_model_idx"
  ON "agent_cost_metrics"("model");
CREATE INDEX IF NOT EXISTS "agent_cost_metrics_createdAt_idx"
  ON "agent_cost_metrics"("createdAt");
CREATE INDEX IF NOT EXISTS "agent_cost_metrics_userFeedback_idx"
  ON "agent_cost_metrics"("userFeedback");

CREATE TABLE IF NOT EXISTS "subagent_model_overrides" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "projectId" TEXT,
  "agentType" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "provider" TEXT,
  "updatedBy" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subagent_model_overrides_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "subagent_model_overrides_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "subagent_model_overrides_workspace_project_agent_key"
  ON "subagent_model_overrides"("workspaceId", "projectId", "agentType")
  WHERE "projectId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "subagent_model_overrides_workspace_agent_default_key"
  ON "subagent_model_overrides"("workspaceId", "agentType")
  WHERE "projectId" IS NULL;
CREATE INDEX IF NOT EXISTS "subagent_model_overrides_workspaceId_idx"
  ON "subagent_model_overrides"("workspaceId");
CREATE INDEX IF NOT EXISTS "subagent_model_overrides_projectId_idx"
  ON "subagent_model_overrides"("projectId");

CREATE TABLE IF NOT EXISTS "agent_eval_results" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT,
  "agentType" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "provider" TEXT,
  "suite" TEXT NOT NULL,
  "totalCases" INTEGER NOT NULL,
  "passedCases" INTEGER NOT NULL,
  "passRate" REAL NOT NULL,
  "avgWallTimeMs" INTEGER NOT NULL DEFAULT 0,
  "avgCreditCost" REAL NOT NULL DEFAULT 0,
  "commitSha" TEXT,
  "metadata" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_eval_results_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "agent_eval_results_agentType_model_createdAt_idx"
  ON "agent_eval_results"("agentType", "model", "createdAt");
CREATE INDEX IF NOT EXISTS "agent_eval_results_workspaceId_idx"
  ON "agent_eval_results"("workspaceId");

CREATE TABLE IF NOT EXISTS "budget_alerts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "creditLimit" REAL NOT NULL,
  "periodType" TEXT NOT NULL DEFAULT 'monthly',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "autoThrottle" BOOLEAN NOT NULL DEFAULT false,
  "throttleToModel" TEXT,
  "notifyEmail" BOOLEAN NOT NULL DEFAULT true,
  "lastTriggeredAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "budget_alerts_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "budget_alerts_workspaceId_idx"
  ON "budget_alerts"("workspaceId");

CREATE TABLE IF NOT EXISTS "model_experiments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "projectId" TEXT,
  "name" TEXT NOT NULL,
  "agentType" TEXT NOT NULL,
  "modelA" TEXT NOT NULL,
  "modelB" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "splitPercentage" INTEGER NOT NULL DEFAULT 50,
  "expectedEndAt" DATETIME,
  "totalRunsA" INTEGER NOT NULL DEFAULT 0,
  "totalRunsB" INTEGER NOT NULL DEFAULT 0,
  "totalCostA" REAL NOT NULL DEFAULT 0,
  "totalCostB" REAL NOT NULL DEFAULT 0,
  "totalTokensA" INTEGER NOT NULL DEFAULT 0,
  "totalTokensB" INTEGER NOT NULL DEFAULT 0,
  "successRateA" REAL NOT NULL DEFAULT 0,
  "successRateB" REAL NOT NULL DEFAULT 0,
  "avgLatencyMsA" REAL NOT NULL DEFAULT 0,
  "avgLatencyMsB" REAL NOT NULL DEFAULT 0,
  "escalationsA" INTEGER NOT NULL DEFAULT 0,
  "escalationsB" INTEGER NOT NULL DEFAULT 0,
  "loopDetectedA" INTEGER NOT NULL DEFAULT 0,
  "loopDetectedB" INTEGER NOT NULL DEFAULT 0,
  "hitMaxTurnsA" INTEGER NOT NULL DEFAULT 0,
  "hitMaxTurnsB" INTEGER NOT NULL DEFAULT 0,
  "responseEmptyA" INTEGER NOT NULL DEFAULT 0,
  "responseEmptyB" INTEGER NOT NULL DEFAULT 0,
  "thumbsUpA" INTEGER NOT NULL DEFAULT 0,
  "thumbsUpB" INTEGER NOT NULL DEFAULT 0,
  "thumbsDownA" INTEGER NOT NULL DEFAULT 0,
  "thumbsDownB" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "model_experiments_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "model_experiments_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "model_experiments_workspaceId_idx"
  ON "model_experiments"("workspaceId");
CREATE INDEX IF NOT EXISTS "model_experiments_status_idx"
  ON "model_experiments"("status");
CREATE INDEX IF NOT EXISTS "model_experiments_workspaceId_agentType_status_idx"
  ON "model_experiments"("workspaceId", "agentType", "status");
