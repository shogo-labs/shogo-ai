CREATE TABLE "agent_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
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
    CONSTRAINT "agent_tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "agent_tasks_chatSessionId_fkey" FOREIGN KEY ("chatSessionId") REFERENCES "chat_sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "agent_tasks_userId_status_idx" ON "agent_tasks"("userId", "status");
CREATE INDEX "agent_tasks_workspaceId_status_idx" ON "agent_tasks"("workspaceId", "status");
CREATE INDEX "agent_tasks_projectId_status_idx" ON "agent_tasks"("projectId", "status");
CREATE INDEX "agent_tasks_chatSessionId_idx" ON "agent_tasks"("chatSessionId");
