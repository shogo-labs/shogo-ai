-- CreateTable
CREATE TABLE "agent_cost_metrics" (
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

-- CreateTable
CREATE TABLE "budget_alerts" (
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

-- CreateTable
CREATE TABLE "model_experiments" (
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

-- CreateIndex
CREATE INDEX "agent_cost_metrics_workspaceId_idx" ON "agent_cost_metrics"("workspaceId");
CREATE INDEX "agent_cost_metrics_projectId_idx" ON "agent_cost_metrics"("projectId");
CREATE INDEX "agent_cost_metrics_agentType_idx" ON "agent_cost_metrics"("agentType");
CREATE INDEX "agent_cost_metrics_model_idx" ON "agent_cost_metrics"("model");
CREATE INDEX "agent_cost_metrics_createdAt_idx" ON "agent_cost_metrics"("createdAt");

CREATE INDEX "budget_alerts_workspaceId_idx" ON "budget_alerts"("workspaceId");

CREATE INDEX "model_experiments_workspaceId_idx" ON "model_experiments"("workspaceId");
CREATE INDEX "model_experiments_status_idx" ON "model_experiments"("status");

-- AddForeignKey
ALTER TABLE "agent_cost_metrics" ADD CONSTRAINT "agent_cost_metrics_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_cost_metrics" ADD CONSTRAINT "agent_cost_metrics_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "model_experiments" ADD CONSTRAINT "model_experiments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "model_experiments" ADD CONSTRAINT "model_experiments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
