CREATE TYPE "AgentTaskStatus" AS ENUM ('draft', 'queued', 'running', 'completed', 'failed', 'cancelled');

CREATE TABLE "agent_tasks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "chatSessionId" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" "AgentTaskStatus" NOT NULL DEFAULT 'draft',
    "currentStep" TEXT,
    "resultSummary" TEXT,
    "errorMessage" TEXT,
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_tasks_userId_status_idx" ON "agent_tasks"("userId", "status");
CREATE INDEX "agent_tasks_workspaceId_status_idx" ON "agent_tasks"("workspaceId", "status");
CREATE INDEX "agent_tasks_projectId_status_idx" ON "agent_tasks"("projectId", "status");
CREATE INDEX "agent_tasks_chatSessionId_idx" ON "agent_tasks"("chatSessionId");

ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_chatSessionId_fkey" FOREIGN KEY ("chatSessionId") REFERENCES "chat_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
