-- Migration: add_workspace_model_visibility
-- Source:    prisma/schema.local.prisma
--
-- Adds the workspace-scoped model allowlist to the desktop SQLite track.
-- Zero rows for a workspace = inherit all platform-visible models; >= 1 row =
-- restrict to exactly those ids. See apps/api workspace-models.service.ts.

-- CreateTable
CREATE TABLE "workspace_model_visibility" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    CONSTRAINT "workspace_model_visibility_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "workspace_model_visibility_workspaceId_idx" ON "workspace_model_visibility"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_model_visibility_workspaceId_modelId_key" ON "workspace_model_visibility"("workspaceId", "modelId");
