-- Local SQLite migration for Phase 2 custom-agent eval sets.
-- Mirrors prisma/schema.local.prisma AgentEvalSet model.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS "agent_eval_sets" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "projectId" TEXT,
  "agentType" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "examples" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_eval_sets_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_eval_sets_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "agent_eval_sets_workspaceId_agentType_idx"
  ON "agent_eval_sets"("workspaceId", "agentType");

CREATE INDEX IF NOT EXISTS "agent_eval_sets_workspaceId_projectId_idx"
  ON "agent_eval_sets"("workspaceId", "projectId");
