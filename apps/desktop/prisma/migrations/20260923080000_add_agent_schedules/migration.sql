CREATE TABLE "agent_schedules" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "goalId" TEXT,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "cronExpression" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "nextRunAt" DATETIME NOT NULL,
  "lastRunAt" DATETIME,
  "lastRunStatus" TEXT,
  "lastRunSummary" TEXT,
  "lastError" TEXT,
  "chatSessionId" TEXT,
  "runningAt" DATETIME,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "agent_schedules_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_schedules_goalId_fkey"
    FOREIGN KEY ("goalId") REFERENCES "goals" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_schedules_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "agent_schedules_enabled_nextRunAt_idx"
  ON "agent_schedules"("enabled", "nextRunAt");
CREATE INDEX "agent_schedules_workspaceId_idx"
  ON "agent_schedules"("workspaceId");
CREATE INDEX "agent_schedules_goalId_idx"
  ON "agent_schedules"("goalId");
CREATE INDEX "agent_schedules_userId_idx"
  ON "agent_schedules"("userId");
