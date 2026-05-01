-- Phase 2 — workspace-authored eval examples for custom sub-agent recommendations.
-- AgentEvalResult and SubagentModelOverride already key by free-form agentType;
-- this table supplies the missing eval source for custom agents created with agent_create.

CREATE TABLE IF NOT EXISTS "agent_eval_sets" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId"   TEXT,
    "agentType"   TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "examples"    JSONB NOT NULL,
    "enabled"     BOOLEAN NOT NULL DEFAULT true,
    "createdBy"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_eval_sets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_eval_sets_workspaceId_agentType_idx"
  ON "agent_eval_sets"("workspaceId", "agentType");

CREATE INDEX IF NOT EXISTS "agent_eval_sets_workspaceId_projectId_idx"
  ON "agent_eval_sets"("workspaceId", "projectId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_eval_sets_workspaceId_fkey'
  ) THEN
    ALTER TABLE "agent_eval_sets"
      ADD CONSTRAINT "agent_eval_sets_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_eval_sets_projectId_fkey'
  ) THEN
    ALTER TABLE "agent_eval_sets"
      ADD CONSTRAINT "agent_eval_sets_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "projects"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
