-- CreateEnum
CREATE TYPE "ConversationKind" AS ENUM ('public', 'private', 'dm', 'group_dm', 'activity');

-- CreateEnum
CREATE TYPE "ConversationMemberType" AS ENUM ('user', 'agent');

-- CreateEnum
CREATE TYPE "ConversationAuthorType" AS ENUM ('user', 'agent', 'bot', 'system');

-- AlterTable
ALTER TABLE "agent_schedules" ADD COLUMN     "notifyConversationId" TEXT;

-- AlterTable
ALTER TABLE "agent_tasks" ADD COLUMN     "notifyConversationId" TEXT;

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "ConversationKind" NOT NULL DEFAULT 'public',
    "name" TEXT,
    "slug" TEXT,
    "topic" TEXT,
    "dmKey" TEXT,
    "createdById" TEXT,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_members" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "memberType" "ConversationMemberType" NOT NULL DEFAULT 'user',
    "userId" TEXT,
    "projectId" TEXT,
    "projectAgentId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "lastReadSeq" INTEGER NOT NULL DEFAULT 0,
    "lastReadAt" TIMESTAMP(3),
    "notifyLevel" TEXT NOT NULL DEFAULT 'all',
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "agentTrigger" TEXT NOT NULL DEFAULT 'mention',
    "agentKeywords" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "threadRootId" TEXT,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "lastReplyAt" TIMESTAMP(3),
    "alsoSentToChannel" BOOLEAN NOT NULL DEFAULT false,
    "authorType" "ConversationAuthorType" NOT NULL DEFAULT 'user',
    "authorUserId" TEXT,
    "authorAgentRef" JSONB,
    "botId" TEXT,
    "text" TEXT NOT NULL,
    "blocks" JSONB,
    "clientMsgId" TEXT,
    "agentSessionId" TEXT,
    "agentStatus" TEXT,
    "externalRef" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_mentions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetUserId" TEXT,
    "projectId" TEXT,
    "projectAgentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_reactions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_attachments" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "uploaderUserId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_workspaceId_kind_idx" ON "conversations"("workspaceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_workspaceId_slug_key" ON "conversations"("workspaceId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_workspaceId_dmKey_key" ON "conversations"("workspaceId", "dmKey");

-- CreateIndex
CREATE INDEX "conversation_members_userId_idx" ON "conversation_members"("userId");

-- CreateIndex
CREATE INDEX "conversation_members_conversationId_memberType_idx" ON "conversation_members"("conversationId", "memberType");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_members_conversationId_userId_key" ON "conversation_members"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "conversation_messages_conversationId_threadRootId_createdAt_idx" ON "conversation_messages"("conversationId", "threadRootId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_messages_threadRootId_createdAt_idx" ON "conversation_messages"("threadRootId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_messages_workspaceId_createdAt_idx" ON "conversation_messages"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_messages_agentSessionId_idx" ON "conversation_messages"("agentSessionId");

-- CreateIndex
CREATE INDEX "conversation_messages_externalRef_idx" ON "conversation_messages"("externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_conversationId_seq_key" ON "conversation_messages"("conversationId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_conversationId_clientMsgId_key" ON "conversation_messages"("conversationId", "clientMsgId");

-- CreateIndex
CREATE INDEX "conversation_mentions_messageId_idx" ON "conversation_mentions"("messageId");

-- CreateIndex
CREATE INDEX "conversation_mentions_targetUserId_createdAt_idx" ON "conversation_mentions"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_reactions_messageId_idx" ON "conversation_reactions"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_reactions_messageId_userId_emoji_key" ON "conversation_reactions"("messageId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "conversation_attachments_conversationId_idx" ON "conversation_attachments"("conversationId");

-- CreateIndex
CREATE INDEX "conversation_attachments_messageId_idx" ON "conversation_attachments"("messageId");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_mentions" ADD CONSTRAINT "conversation_mentions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_reactions" ADD CONSTRAINT "conversation_reactions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
