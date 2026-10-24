-- CreateTable
CREATE TABLE "social_automations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'comment_dm',
    "zernioResourceId" TEXT,
    "platform" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'static',
    "status" TEXT NOT NULL DEFAULT 'active',
    "keywords" TEXT NOT NULL DEFAULT '[]',
    "config" JSONB,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "social_automations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "social_automations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "social_accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "social_automation_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "automationId" TEXT,
    "zernioExecutionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "social_automation_runs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "social_automation_runs_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "social_automations" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "social_automations_zernioResourceId_key" ON "social_automations"("zernioResourceId");

-- CreateIndex
CREATE INDEX "social_automations_workspaceId_status_idx" ON "social_automations"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "social_automations_workspaceId_kind_idx" ON "social_automations"("workspaceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "social_automation_runs_zernioExecutionId_key" ON "social_automation_runs"("zernioExecutionId");

-- CreateIndex
CREATE INDEX "social_automation_runs_workspaceId_startedAt_idx" ON "social_automation_runs"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "social_automation_runs_automationId_idx" ON "social_automation_runs"("automationId");

