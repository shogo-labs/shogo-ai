-- CreateTable
CREATE TABLE "project_agents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "systemPrompt" TEXT,
    "toolsAllowlist" TEXT,
    "tools" TEXT,
    "characterName" TEXT,
    "displayName" TEXT,
    "voiceId" TEXT,
    "firstMessage" TEXT,
    "elevenlabsAgentId" TEXT,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "project_agents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "project_agents_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "project_agents_workspaceId_idx" ON "project_agents"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "project_agents_projectId_name_key" ON "project_agents"("projectId", "name");
