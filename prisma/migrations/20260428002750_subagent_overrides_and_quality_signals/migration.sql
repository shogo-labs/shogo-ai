-- Some local/dev databases have the 20260408120000 migration recorded without
-- the cost analytics tables present. Recreate the base tables only when absent
-- so this pending migration can repair that drift without forcing a reset.
CREATE TABLE IF NOT EXISTS "agent_cost_metrics" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "agentType" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "creditCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "wallTimeMs" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_cost_metrics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "budget_alerts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "creditLimit" DOUBLE PRECISION NOT NULL,
    "periodType" TEXT NOT NULL DEFAULT 'monthly',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "autoThrottle" BOOLEAN NOT NULL DEFAULT false,
    "throttleToModel" TEXT,
    "notifyEmail" BOOLEAN NOT NULL DEFAULT true,
    "lastTriggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_alerts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "model_experiments" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "modelA" TEXT NOT NULL,
    "modelB" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "splitPercentage" INTEGER NOT NULL DEFAULT 50,
    "totalRunsA" INTEGER NOT NULL DEFAULT 0,
    "totalRunsB" INTEGER NOT NULL DEFAULT 0,
    "totalCostA" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCostB" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTokensA" INTEGER NOT NULL DEFAULT 0,
    "totalTokensB" INTEGER NOT NULL DEFAULT 0,
    "successRateA" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "successRateB" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgLatencyMsA" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgLatencyMsB" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_experiments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_cost_metrics_workspaceId_idx" ON "agent_cost_metrics"("workspaceId");
CREATE INDEX IF NOT EXISTS "agent_cost_metrics_projectId_idx" ON "agent_cost_metrics"("projectId");
CREATE INDEX IF NOT EXISTS "agent_cost_metrics_agentType_idx" ON "agent_cost_metrics"("agentType");
CREATE INDEX IF NOT EXISTS "agent_cost_metrics_model_idx" ON "agent_cost_metrics"("model");
CREATE INDEX IF NOT EXISTS "agent_cost_metrics_createdAt_idx" ON "agent_cost_metrics"("createdAt");
CREATE INDEX IF NOT EXISTS "budget_alerts_workspaceId_idx" ON "budget_alerts"("workspaceId");
CREATE INDEX IF NOT EXISTS "model_experiments_workspaceId_idx" ON "model_experiments"("workspaceId");
CREATE INDEX IF NOT EXISTS "model_experiments_status_idx" ON "model_experiments"("status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_cost_metrics_workspaceId_fkey'
  ) THEN
    ALTER TABLE "agent_cost_metrics"
      ADD CONSTRAINT "agent_cost_metrics_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_cost_metrics_projectId_fkey'
  ) THEN
    ALTER TABLE "agent_cost_metrics"
      ADD CONSTRAINT "agent_cost_metrics_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "projects"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'budget_alerts_workspaceId_fkey'
  ) THEN
    ALTER TABLE "budget_alerts"
      ADD CONSTRAINT "budget_alerts_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'model_experiments_workspaceId_fkey'
  ) THEN
    ALTER TABLE "model_experiments"
      ADD CONSTRAINT "model_experiments_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'model_experiments_projectId_fkey'
  ) THEN
    ALTER TABLE "model_experiments"
      ADD CONSTRAINT "model_experiments_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "projects"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Quality-signal columns on agent_cost_metrics ----------------------------------
ALTER TABLE "agent_cost_metrics"
  ADD COLUMN IF NOT EXISTS "agentRunId" TEXT,
  ADD COLUMN IF NOT EXISTS "hitMaxTurns" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "loopDetected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "escalated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "responseEmpty" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_cost_metrics_agentRunId_key"
  ON "agent_cost_metrics"("agentRunId");

-- Subagent model overrides ------------------------------------------------------
CREATE TABLE IF NOT EXISTS "subagent_model_overrides" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId"   TEXT,
    "agentType"   TEXT NOT NULL,
    "model"       TEXT NOT NULL,
    "provider"    TEXT,
    "updatedBy"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subagent_model_overrides_pkey" PRIMARY KEY ("id")
);

-- Postgres NULLS DISTINCT default would let multiple workspace-default rows exist.
-- We need exactly one row per (workspaceId, projectId, agentType) including the
-- workspace-default form (projectId IS NULL), so use NULLS NOT DISTINCT.
CREATE UNIQUE INDEX IF NOT EXISTS "subagent_model_overrides_workspace_project_agent_key"
  ON "subagent_model_overrides"("workspaceId", "projectId", "agentType")
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS "subagent_model_overrides_workspaceId_idx"
  ON "subagent_model_overrides"("workspaceId");
CREATE INDEX IF NOT EXISTS "subagent_model_overrides_projectId_idx"
  ON "subagent_model_overrides"("projectId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subagent_model_overrides_workspaceId_fkey'
  ) THEN
    ALTER TABLE "subagent_model_overrides"
      ADD CONSTRAINT "subagent_model_overrides_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subagent_model_overrides_projectId_fkey'
  ) THEN
    ALTER TABLE "subagent_model_overrides"
      ADD CONSTRAINT "subagent_model_overrides_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "projects"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Agent eval results ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "agent_eval_results" (
    "id"             TEXT NOT NULL,
    "workspaceId"    TEXT,
    "agentType"      TEXT NOT NULL,
    "model"          TEXT NOT NULL,
    "provider"       TEXT,
    "suite"          TEXT NOT NULL,
    "totalCases"     INTEGER NOT NULL,
    "passedCases"    INTEGER NOT NULL,
    "passRate"       DOUBLE PRECISION NOT NULL,
    "avgWallTimeMs"  INTEGER NOT NULL DEFAULT 0,
    "avgCreditCost"  DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commitSha"      TEXT,
    "metadata"       JSONB,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_eval_results_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_eval_results_agentType_model_createdAt_idx"
  ON "agent_eval_results"("agentType", "model", "createdAt");
CREATE INDEX IF NOT EXISTS "agent_eval_results_workspaceId_idx"
  ON "agent_eval_results"("workspaceId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_eval_results_workspaceId_fkey'
  ) THEN
    ALTER TABLE "agent_eval_results"
      ADD CONSTRAINT "agent_eval_results_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
