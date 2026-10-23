-- Migration: social_inbox
-- Source:    prisma/schema.prisma
--
-- P4 of SHO-71: the unified inbox. Conversations, messages and comments are
-- written by the provider's webhooks and by the backfill sweep, so the UI reads
-- our tables instead of polling Zernio per render. Every row is unique on the
-- provider's own id, which is what makes a redelivered webhook and an
-- overlapping sweep the same row rather than a duplicate.
--
-- Also carries the two delivery-hardening columns from the P3 gate: a relayed
-- event that cannot be applied is retried (attempts/lastError) and eventually
-- dead-lettered (failedAt) instead of being acked away.

-- AlterTable
ALTER TABLE "social_relayed_events" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN "lastError" TEXT,
ADD COLUMN "failedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "social_relayed_events_workspaceId_failedAt_idx" ON "social_relayed_events"("workspaceId", "failedAt");

-- CreateTable
CREATE TABLE "social_conversations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT,
    "zernioConversationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "participantId" TEXT,
    "participantName" TEXT,
    "participantPicture" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "lastMessagePreview" TEXT,
    "assignedToUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_messages" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "zernioMessageId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "text" TEXT,
    "attachmentsJson" JSONB,
    "authorId" TEXT,
    "authorName" TEXT,
    "authorUsername" TEXT,
    "authorPicture" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "error" TEXT,
    "metered" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_comments" (
    "id" TEXT NOT NULL,
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
    "repliedAt" TIMESTAMP(3),
    "permalink" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_comments_pkey" PRIMARY KEY ("id")
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

-- AddForeignKey
ALTER TABLE "social_conversations" ADD CONSTRAINT "social_conversations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_conversations" ADD CONSTRAINT "social_conversations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "social_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_messages" ADD CONSTRAINT "social_messages_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_messages" ADD CONSTRAINT "social_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "social_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_comments" ADD CONSTRAINT "social_comments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_comments" ADD CONSTRAINT "social_comments_postId_fkey" FOREIGN KEY ("postId") REFERENCES "social_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_comments" ADD CONSTRAINT "social_comments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "social_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
