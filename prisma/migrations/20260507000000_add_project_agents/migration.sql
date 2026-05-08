-- Migration: ProjectAgent — unified named-agent record per project,
-- reachable from both useShogoVoice({ agentName }) and
-- useShogoChat({ agentName }). Backfilled with a `default` row per
-- existing voice_project_configs.elevenlabsAgentId so the new
-- resolver finds a row for every project that already has a default
-- voice agent provisioned.

CREATE TABLE "project_agents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    -- Shared fields (used by both modalities)
    "systemPrompt" TEXT,
    "toolsAllowlist" JSONB,
    "characterName" TEXT,
    "displayName" TEXT,

    -- Voice-only
    "voiceId" TEXT,
    "firstMessage" TEXT,
    "elevenlabsAgentId" TEXT,

    -- Chat-only
    "model" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_agents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_agents_projectId_name_key" ON "project_agents"("projectId", "name");
CREATE INDEX "project_agents_workspaceId_idx" ON "project_agents"("workspaceId");

ALTER TABLE "project_agents"
  ADD CONSTRAINT "project_agents_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_agents"
  ADD CONSTRAINT "project_agents_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: insert one `default` row per existing voice_project_configs
-- row that has an EL agent provisioned. Use a deterministic synthetic
-- id so re-running the migration is idempotent (we'd error on
-- duplicate primary key — that's the desired behavior).
INSERT INTO "project_agents" (
  "id",
  "projectId",
  "workspaceId",
  "name",
  "elevenlabsAgentId",
  "createdAt",
  "updatedAt"
)
SELECT
  'pa_default_' || "id",
  "projectId",
  "workspaceId",
  'default',
  "elevenlabsAgentId",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "voice_project_configs"
WHERE "elevenlabsAgentId" IS NOT NULL;
