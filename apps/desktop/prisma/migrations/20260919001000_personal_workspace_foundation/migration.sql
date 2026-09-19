ALTER TABLE "workspaces" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'team';
ALTER TABLE "projects" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "chat_sessions" ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "workspace_agent_profiles" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT 'Shogo',
  "avatarUrl" TEXT,
  "tagline" TEXT,
  "personality" TEXT,
  "statusText" TEXT,
  "statusUpdatedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "workspace_agent_profiles_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "workspace_agent_profiles_workspaceId_key"
  ON "workspace_agent_profiles"("workspaceId");

CREATE TABLE "goals" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "why" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "plan" TEXT NOT NULL DEFAULT '[]',
  "deliverables" TEXT NOT NULL DEFAULT '[]',
  "nextCheckInAt" DATETIME,
  "lastProgressAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "goals_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "goals_workspaceId_status_idx" ON "goals"("workspaceId", "status");
CREATE INDEX "goals_workspaceId_updatedAt_idx" ON "goals"("workspaceId", "updatedAt");

CREATE TABLE "goal_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "goalId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "goal_events_goalId_fkey"
    FOREIGN KEY ("goalId") REFERENCES "goals" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "goal_events_goalId_createdAt_idx" ON "goal_events"("goalId", "createdAt");

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_agent_tasks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "goalId" TEXT,
  "projectId" TEXT,
  "chatSessionId" TEXT,
  "title" TEXT NOT NULL,
  "notes" TEXT,
  "dueAt" DATETIME,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "currentStep" TEXT,
  "resultSummary" TEXT,
  "errorMessage" TEXT,
  "queuedAt" DATETIME,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "agent_tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_tasks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_tasks_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "agent_tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "agent_tasks_chatSessionId_fkey" FOREIGN KEY ("chatSessionId") REFERENCES "chat_sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_agent_tasks" (
  "chatSessionId", "completedAt", "createdAt", "currentStep", "dueAt",
  "errorMessage", "goalId", "id", "notes", "projectId", "queuedAt",
  "resultSummary", "startedAt", "status", "title", "updatedAt", "userId",
  "workspaceId"
)
SELECT
  "chatSessionId", "completedAt", "createdAt", "currentStep", "dueAt",
  "errorMessage", NULL, "id", "notes", "projectId", "queuedAt",
  "resultSummary", "startedAt", "status", "title", "updatedAt", "userId",
  "workspaceId"
FROM "agent_tasks";
DROP TABLE "agent_tasks";
ALTER TABLE "new_agent_tasks" RENAME TO "agent_tasks";
CREATE INDEX "agent_tasks_userId_status_idx" ON "agent_tasks"("userId", "status");
CREATE INDEX "agent_tasks_workspaceId_status_idx" ON "agent_tasks"("workspaceId", "status");
CREATE INDEX "agent_tasks_goalId_status_idx" ON "agent_tasks"("goalId", "status");
CREATE INDEX "agent_tasks_projectId_status_idx" ON "agent_tasks"("projectId", "status");
CREATE INDEX "agent_tasks_chatSessionId_idx" ON "agent_tasks"("chatSessionId");
CREATE INDEX "agent_tasks_status_dueAt_idx" ON "agent_tasks"("status", "dueAt");
CREATE INDEX "agent_tasks_status_updatedAt_idx" ON "agent_tasks"("status", "updatedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

CREATE INDEX "projects_workspaceId_hidden_idx" ON "projects"("workspaceId", "hidden");

-- Existing personal workspaces are identified conservatively: only empty
-- personal slugs are migrated so legacy builder workspaces remain visible.
UPDATE "workspaces"
SET "kind" = 'personal'
WHERE "slug" LIKE 'user-%-personal'
  AND NOT EXISTS (
    SELECT 1 FROM "projects" WHERE "projects"."workspaceId" = "workspaces"."id"
  );
