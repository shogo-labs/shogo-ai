-- Migration: add_project_attachments
-- Generated: 2026-06-02T22:49:27.208Z by scripts/db-migrate-desktop.ts
-- Source:    prisma/schema.local.prisma
--
-- Persistent project-to-project attachment. The anchor project's merged-root
-- workspace runtime mounts each attached project as an additional member root.
-- (Trimmed to the new table only; unrelated pre-existing schema drift emitted
-- by `migrate diff` was removed so this migration is scoped to its change.)

-- CreateTable
CREATE TABLE "project_attachments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "attachedProjectId" TEXT NOT NULL,
    "attachMode" TEXT NOT NULL DEFAULT 'readwrite',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_attachments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "project_attachments_attachedProjectId_fkey" FOREIGN KEY ("attachedProjectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "project_attachments_projectId_idx" ON "project_attachments"("projectId");

-- CreateIndex
CREATE INDEX "project_attachments_attachedProjectId_idx" ON "project_attachments"("attachedProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_attachments_projectId_attachedProjectId_key" ON "project_attachments"("projectId", "attachedProjectId");
