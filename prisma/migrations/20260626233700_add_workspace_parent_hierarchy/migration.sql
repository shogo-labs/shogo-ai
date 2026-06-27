-- Add an optional self-referential parent link to workspaces.
--
-- When set, a workspace is a "child" that pools the parent's plan, usage
-- wallet, and seats (it has no subscription/wallet of its own). Only
-- Business/Enterprise workspaces are allowed to have children. ON DELETE
-- SET NULL so deleting a parent orphans children rather than cascading.
ALTER TABLE "workspaces" ADD COLUMN "parentWorkspaceId" TEXT;

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_parentWorkspaceId_fkey"
  FOREIGN KEY ("parentWorkspaceId") REFERENCES "workspaces"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "workspaces_parentWorkspaceId_idx" ON "workspaces"("parentWorkspaceId");
