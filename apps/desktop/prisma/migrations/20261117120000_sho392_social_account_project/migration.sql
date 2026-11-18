-- Migration: SocialAccount.projectId
-- Source:    prisma/schema.local.prisma
--
-- Desktop/self-hosted keeps the column for schema parity with the cloud track.
-- A connected account belongs to a project (or to the whole workspace when
-- `projectId` is null). Nullable and additive: every existing row keeps working
-- as a workspace-shared account.

-- AlterTable
ALTER TABLE "social_accounts" ADD COLUMN "projectId" TEXT;

-- CreateIndex
CREATE INDEX "social_accounts_workspaceId_projectId_idx" ON "social_accounts"("workspaceId", "projectId");
