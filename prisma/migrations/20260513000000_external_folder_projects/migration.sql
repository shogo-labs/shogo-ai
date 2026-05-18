-- Migration: external folder projects (Shogo Desktop, VS Code-style).
--
-- Adds three columns to `projects` and a new `project_folders` table.
-- See packages/agent-runtime/src/gateway-tools.ts (`assertAllowedPath`)
-- and apps/api/src/routes/local-projects.ts for the surface that uses
-- them. Defaults match existing behavior for managed (cloud) projects:
--   workingMode='managed', runtimeEnabled=true, trustLevel='trusted'.

ALTER TABLE "projects"
  ADD COLUMN "workingMode" TEXT NOT NULL DEFAULT 'managed',
  ADD COLUMN "runtimeEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "trustLevel" TEXT NOT NULL DEFAULT 'trusted';

CREATE TABLE "project_folders" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOpenedAt" TIMESTAMP(3),

    CONSTRAINT "project_folders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_folders_projectId_idx" ON "project_folders"("projectId");

ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
