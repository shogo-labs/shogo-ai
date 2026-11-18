-- Migration: SocialAccount.projectId
--
-- A connected social account belongs to a project (or to the whole workspace
-- when `projectId` is null). Nullable and additive: every existing row keeps
-- working as a workspace-shared account, which is exactly what it is today.
--
-- No foreign key on purpose. The cloud keeps mirror rows for accounts a desktop
-- connected through the relay, and those carry local project ids the cloud has
-- no `projects` row for. Project delete sets `projectId = NULL` (the account
-- becomes shared) instead of deleting the row or the Zernio account.

-- AlterTable
ALTER TABLE "social_accounts" ADD COLUMN "projectId" TEXT;

-- CreateIndex
CREATE INDEX "social_accounts_workspaceId_projectId_idx" ON "social_accounts"("workspaceId", "projectId");
