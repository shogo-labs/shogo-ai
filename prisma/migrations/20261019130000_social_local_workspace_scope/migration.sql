-- Migration: social_local_workspace_scope
-- Source:    prisma/schema.prisma
--
-- Each local workspace on a desktop gets its own Zernio profile, so the
-- profile's uniqueness moves from `workspaceId` to the scope pair, and the
-- routing id becomes derived (`ws_<workspaceId>` / `lws_<localWorkspaceId>`)
-- because it is the only key Zernio echoes back on a webhook.

-- AlterTable
ALTER TABLE "social_profiles" ADD COLUMN "localWorkspaceId" TEXT NOT NULL DEFAULT '';

-- DropIndex + CreateIndex: uniqueness is per scope, not per workspace
DROP INDEX "social_profiles_workspaceId_key";
CREATE UNIQUE INDEX "social_profiles_workspaceId_localWorkspaceId_key" ON "social_profiles"("workspaceId", "localWorkspaceId");

-- Existing rows predate the derived routing id and all belong to the cloud
-- scope, so they take the `ws_` form the webhook route now resolves.
UPDATE "social_profiles" SET "externalId" = 'ws_' || "workspaceId";
