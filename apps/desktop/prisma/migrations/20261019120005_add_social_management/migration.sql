-- Migration: add_social_management
-- Source:    prisma/schema.local.prisma
--
-- SQLite mirror of prisma/migrations/20261019120000_add_social_management.
-- Json? columns are TEXT holding JSON; String[] is a JSON-encoded TEXT column.

-- CreateTable
CREATE TABLE "social_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "zernioProfileId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "social_profiles_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "social_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "zernioAccountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tokenHealthy" BOOLEAN NOT NULL DEFAULT true,
    "needsReconnect" BOOLEAN NOT NULL DEFAULT false,
    "lastHealthAt" DATETIME,
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "social_accounts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "social_accounts_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "social_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "social_posts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "content" TEXT NOT NULL,
    "mediaJson" TEXT,
    "scheduledFor" DATETIME,
    "publishedAt" DATETIME,
    "zernioPostId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "social_posts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "social_post_targets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "postId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "customContent" TEXT,
    "mediaJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "platformPostId" TEXT,
    "platformPostUrl" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "social_post_targets_postId_fkey" FOREIGN KEY ("postId") REFERENCES "social_posts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "social_post_targets_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "social_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "social_profiles_workspaceId_key" ON "social_profiles"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "social_profiles_zernioProfileId_key" ON "social_profiles"("zernioProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "social_profiles_externalId_key" ON "social_profiles"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_zernioAccountId_key" ON "social_accounts"("zernioAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_workspaceId_platform_username_key" ON "social_accounts"("workspaceId", "platform", "username");

-- CreateIndex
CREATE INDEX "social_accounts_workspaceId_platform_idx" ON "social_accounts"("workspaceId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "social_posts_idempotencyKey_key" ON "social_posts"("idempotencyKey");

-- CreateIndex
CREATE INDEX "social_posts_workspaceId_scheduledFor_idx" ON "social_posts"("workspaceId", "scheduledFor");

-- CreateIndex
CREATE INDEX "social_posts_workspaceId_status_idx" ON "social_posts"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "social_post_targets_postId_accountId_key" ON "social_post_targets"("postId", "accountId");

-- CreateIndex
CREATE INDEX "social_post_targets_accountId_status_idx" ON "social_post_targets"("accountId", "status");
