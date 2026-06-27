-- Migration: add_workspace_parent_hierarchy
-- Adds an optional self-referential parent link to workspaces so that
-- Business/Enterprise workspaces can spawn free "child" workspaces that
-- pool the parent's plan, usage wallet, and seats.
--
-- SQLite permits adding a nullable column with a column-level REFERENCES
-- clause as long as its default is NULL (which it is here), so no table
-- rebuild is required.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "parentWorkspaceId" TEXT REFERENCES "workspaces" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "workspaces_parentWorkspaceId_idx" ON "workspaces"("parentWorkspaceId");
