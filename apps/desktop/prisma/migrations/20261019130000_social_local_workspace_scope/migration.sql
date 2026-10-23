-- Migration: social_local_workspace_scope
-- Source:    prisma/schema.local.prisma
--
-- SQLite mirror of prisma/migrations/20261019130000_social_local_workspace_scope.
-- Dropping an index is a standalone statement on SQLite, so no table rebuild
-- is needed to move uniqueness from `workspaceId` to the scope pair.

-- AlterTable
ALTER TABLE "social_profiles" ADD COLUMN "localWorkspaceId" TEXT NOT NULL DEFAULT '';

-- DropIndex + CreateIndex: uniqueness is per scope, not per workspace
DROP INDEX "social_profiles_workspaceId_key";
CREATE UNIQUE INDEX "social_profiles_workspaceId_localWorkspaceId_key" ON "social_profiles"("workspaceId", "localWorkspaceId");

-- Existing rows predate the derived routing id and all belong to the cloud
-- scope, so they take the `ws_` form the webhook route now resolves.
UPDATE "social_profiles" SET "externalId" = 'ws_' || "workspaceId";
