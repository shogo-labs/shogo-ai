-- AlterTable
ALTER TABLE "conversation_attachments" ADD COLUMN     "extractedText" TEXT;

-- AlterTable
ALTER TABLE "conversation_members" ALTER COLUMN "notifyLevel" SET DEFAULT 'default';

-- CreateTable
CREATE TABLE "chat_user_settings" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "statusEmoji" TEXT,
    "statusText" TEXT,
    "statusExpiresAt" TIMESTAMP(3),
    "dndUntil" TIMESTAMP(3),
    "quietHours" TEXT,
    "timezone" TEXT,
    "notifyDefault" TEXT NOT NULL DEFAULT 'mentions',
    "keywords" TEXT,
    "emailDigest" TEXT NOT NULL DEFAULT 'off',
    "lastDigestAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_pins" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "pinnedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_pins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_messages" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_drafts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "threadRootId" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_messages" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadRootId" TEXT,
    "alsoSentToChannel" BOOLEAN NOT NULL DEFAULT false,
    "text" TEXT NOT NULL,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sentMessageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_reminders" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "remindAt" TIMESTAMP(3) NOT NULL,
    "messageId" TEXT,
    "conversationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "firedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_inbox_items" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "actorUserId" TEXT,
    "title" TEXT NOT NULL,
    "preview" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_inbox_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_emoji" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_emoji_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_groups" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_group_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_message_embeddings" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_message_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_user_settings_emailDigest_idx" ON "chat_user_settings"("emailDigest");

-- CreateIndex
CREATE UNIQUE INDEX "chat_user_settings_workspaceId_userId_key" ON "chat_user_settings"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_pins_messageId_key" ON "conversation_pins"("messageId");

-- CreateIndex
CREATE INDEX "conversation_pins_conversationId_createdAt_idx" ON "conversation_pins"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "saved_messages_userId_createdAt_idx" ON "saved_messages"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "saved_messages_userId_messageId_key" ON "saved_messages"("userId", "messageId");

-- CreateIndex
CREATE INDEX "conversation_drafts_userId_updatedAt_idx" ON "conversation_drafts"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_drafts_userId_conversationId_threadRootId_key" ON "conversation_drafts"("userId", "conversationId", "threadRootId");

-- CreateIndex
CREATE INDEX "scheduled_messages_status_sendAt_idx" ON "scheduled_messages"("status", "sendAt");

-- CreateIndex
CREATE INDEX "scheduled_messages_userId_status_idx" ON "scheduled_messages"("userId", "status");

-- CreateIndex
CREATE INDEX "chat_reminders_status_remindAt_idx" ON "chat_reminders"("status", "remindAt");

-- CreateIndex
CREATE INDEX "chat_reminders_userId_status_idx" ON "chat_reminders"("userId", "status");

-- CreateIndex
CREATE INDEX "chat_inbox_items_userId_workspaceId_createdAt_idx" ON "chat_inbox_items"("userId", "workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_inbox_items_userId_readAt_idx" ON "chat_inbox_items"("userId", "readAt");

-- CreateIndex
CREATE INDEX "chat_inbox_items_messageId_idx" ON "chat_inbox_items"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_emoji_workspaceId_name_key" ON "custom_emoji"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "user_groups_workspaceId_handle_key" ON "user_groups"("workspaceId", "handle");

-- CreateIndex
CREATE INDEX "user_group_members_userId_idx" ON "user_group_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_group_members_groupId_userId_key" ON "user_group_members"("groupId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_message_embeddings_messageId_key" ON "conversation_message_embeddings"("messageId");

-- CreateIndex
CREATE INDEX "conversation_message_embeddings_workspaceId_createdAt_idx" ON "conversation_message_embeddings"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "conversation_pins" ADD CONSTRAINT "conversation_pins_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_pins" ADD CONSTRAINT "conversation_pins_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_messages" ADD CONSTRAINT "saved_messages_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_drafts" ADD CONSTRAINT "conversation_drafts_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "user_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_message_embeddings" ADD CONSTRAINT "conversation_message_embeddings_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
