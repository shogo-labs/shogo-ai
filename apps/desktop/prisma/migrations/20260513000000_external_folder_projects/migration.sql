-- Migration: external folder projects (Shogo Desktop, VS Code-style).
-- SQLite mirror of prisma/migrations/20260513000000_external_folder_projects/migration.sql.
--
-- SQLite ALTER TABLE only supports adding one column at a time, but each
-- ADD COLUMN must be a separate statement.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "workingMode" TEXT NOT NULL DEFAULT 'managed';
ALTER TABLE "projects" ADD COLUMN "runtimeEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "projects" ADD COLUMN "trustLevel" TEXT NOT NULL DEFAULT 'trusted';

-- CreateTable
CREATE TABLE "project_folders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOpenedAt" DATETIME,
    CONSTRAINT "project_folders_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "project_folders_projectId_idx" ON "project_folders"("projectId");
