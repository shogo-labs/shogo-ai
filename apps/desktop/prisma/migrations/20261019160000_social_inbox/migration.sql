-- Migration: social_inbox
-- Source:    prisma/schema.local.prisma
--
-- SQLite mirror of prisma/migrations/20261019160000_social_inbox.
-- The unified inbox: conversations, messages and comments written by the
-- provider's webhooks and by the backfill sweep, each unique on the provider's
-- own id so a redelivery and an overlapping sweep are one row.
--
-- The relayed-delivery hardening from the P3 gate ships alongside it: an
-- undeliverable event is retried instead of acked away, and dead-lettered
-- after the attempt cap.

-- AlterTable
ALTER TABLE "social_relayed_events" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "social_relayed_events" ADD COLUMN "lastAttemptAt" DATETIME;
ALTER TABLE "social_relayed_events" ADD COLUMN "lastError" TEXT;
ALTER TABLE "social_relayed_events" ADD COLUMN "failedAt" DATETIME;

-- CreateIndex
CREATE INDEX "social_relayed_events_workspaceId_failedAt_idx" ON "social_relayed_events"("workspaceId", "failedAt");

-- CreateTable
CREATE TABLE "social_conversations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT,
    "zernioConversationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "participantId" TEXT,
    "participantName" TEXT,
    "participantPicture" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" DATETIME,
    "lastMessagePreview" TEXT,
    "assignedToUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "social_conversations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "social_conversations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "social_accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "social_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "zernioMessageId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "text" TEXT,
    "attachmentsJson" TEXT,
    "authorId" TEXT,
    "authorName" TEXT,
    "authorUsername" TEXT,
    "authorPicture" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "error" TEXT,
    "metered" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "social_messages_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "social_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "social_conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "social_comments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "postId" TEXT,
    "accountId" TEXT,
    "zernioCommentId" TEXT NOT NULL,
    "zernioPostId" TEXT NOT NULL,
    "platformPostId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT,
    "authorUsername" TEXT,
    "authorPicture" TEXT,
    "isOwn" BOOLEAN NOT NULL DEFAULT false,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'new',
    "repliedAt" DATETIME,
    "permalink" TEXT,
    "occurredAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "social_comments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "social_comments_postId_fkey" FOREIGN KEY ("postId") REFERENCES "social_posts" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "social_comments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "social_accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "social_conversations_zernioConversationId_key" ON "social_conversations"("zernioConversationId");

-- CreateIndex
CREATE INDEX "social_conversations_workspaceId_lastMessageAt_idx" ON "social_conversations"("workspaceId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "social_conversations_workspaceId_unreadCount_idx" ON "social_conversations"("workspaceId", "unreadCount");

-- CreateIndex
CREATE INDEX "social_conversations_workspaceId_platform_idx" ON "social_conversations"("workspaceId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "social_messages_zernioMessageId_key" ON "social_messages"("zernioMessageId");

-- CreateIndex
CREATE INDEX "social_messages_conversationId_sentAt_idx" ON "social_messages"("conversationId", "sentAt");

-- CreateIndex
CREATE INDEX "social_messages_workspaceId_sentAt_idx" ON "social_messages"("workspaceId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "social_comments_zernioCommentId_key" ON "social_comments"("zernioCommentId");

-- CreateIndex
CREATE INDEX "social_comments_workspaceId_occurredAt_idx" ON "social_comments"("workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "social_comments_workspaceId_status_idx" ON "social_comments"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "social_comments_zernioPostId_idx" ON "social_comments"("zernioPostId");
