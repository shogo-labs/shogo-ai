CREATE TABLE "agent_schedules" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "goalId" TEXT,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "cronExpression" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "nextRunAt" TIMESTAMP(3) NOT NULL,
  "lastRunAt" TIMESTAMP(3),
  "lastRunStatus" TEXT,
  "lastRunSummary" TEXT,
  "lastError" TEXT,
  "chatSessionId" TEXT,
  "runningAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_schedules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_schedules_enabled_nextRunAt_idx"
  ON "agent_schedules"("enabled", "nextRunAt");
CREATE INDEX "agent_schedules_workspaceId_idx"
  ON "agent_schedules"("workspaceId");
CREATE INDEX "agent_schedules_goalId_idx"
  ON "agent_schedules"("goalId");
CREATE INDEX "agent_schedules_userId_idx"
  ON "agent_schedules"("userId");

ALTER TABLE "agent_schedules"
  ADD CONSTRAINT "agent_schedules_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_schedules"
  ADD CONSTRAINT "agent_schedules_goalId_fkey"
  FOREIGN KEY ("goalId") REFERENCES "goals"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_schedules"
  ADD CONSTRAINT "agent_schedules_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
