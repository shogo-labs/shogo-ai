-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'shogo';

-- CreateTable
CREATE TABLE "chat_installations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalTenantId" TEXT NOT NULL,
    "tenantName" TEXT,
    "botUserId" TEXT,
    "tokensEncrypted" TEXT,
    "config" JSONB,
    "installedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_identity_links" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalTenantId" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_identity_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_installations_workspaceId_provider_key" ON "chat_installations"("workspaceId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "chat_installations_provider_externalTenantId_key" ON "chat_installations"("provider", "externalTenantId");

-- CreateIndex
CREATE INDEX "chat_identity_links_userId_idx" ON "chat_identity_links"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_identity_links_provider_externalTenantId_externalUserI_key" ON "chat_identity_links"("provider", "externalTenantId", "externalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_workspaceId_provider_externalId_key" ON "conversations"("workspaceId", "provider", "externalId");

-- AddForeignKey
ALTER TABLE "chat_installations" ADD CONSTRAINT "chat_installations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_identity_links" ADD CONSTRAINT "chat_identity_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing Slack installs and account links are copied into these tables by
-- scripts/backfill-chat-installations.ts, run once on the primary region after
-- the release. It is deliberately not part of this migration: DDL is applied by
-- `migrate deploy` in every region, but INSERTs are replicated, so a backfill
-- here would insert the same 'slack-<id>' rows in both regions and stop
-- logical replication on insert_exists.
