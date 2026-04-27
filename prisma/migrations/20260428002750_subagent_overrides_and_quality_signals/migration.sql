-- Quality-signal columns on agent_cost_metrics ----------------------------------
ALTER TABLE "agent_cost_metrics"
  ADD COLUMN "agentRunId"   TEXT,
  ADD COLUMN "hitMaxTurns"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "loopDetected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "escalated"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "responseEmpty" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "userFeedback" TEXT;

CREATE UNIQUE INDEX "agent_cost_metrics_agentRunId_key"
  ON "agent_cost_metrics"("agentRunId");
CREATE INDEX "agent_cost_metrics_userFeedback_idx"
  ON "agent_cost_metrics"("userFeedback");

-- Subagent model overrides ------------------------------------------------------
CREATE TABLE "subagent_model_overrides" (
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
CREATE UNIQUE INDEX "subagent_model_overrides_workspace_project_agent_key"
  ON "subagent_model_overrides"("workspaceId", "projectId", "agentType")
  NULLS NOT DISTINCT;

CREATE INDEX "subagent_model_overrides_workspaceId_idx"
  ON "subagent_model_overrides"("workspaceId");
CREATE INDEX "subagent_model_overrides_projectId_idx"
  ON "subagent_model_overrides"("projectId");

ALTER TABLE "subagent_model_overrides"
  ADD CONSTRAINT "subagent_model_overrides_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subagent_model_overrides"
  ADD CONSTRAINT "subagent_model_overrides_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Agent eval results ------------------------------------------------------------
CREATE TABLE "agent_eval_results" (
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

CREATE INDEX "agent_eval_results_agentType_model_createdAt_idx"
  ON "agent_eval_results"("agentType", "model", "createdAt");
CREATE INDEX "agent_eval_results_workspaceId_idx"
  ON "agent_eval_results"("workspaceId");

ALTER TABLE "agent_eval_results"
  ADD CONSTRAINT "agent_eval_results_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
