-- Migration: add_chat_message_author
-- Desktop:   apps/desktop/prisma/migrations/20261024180000_add_chat_message_author
--
-- `ChatMessage` had no author column, so an admin export of "what did this
-- person send" could not say who typed a prompt in a shared project chat. The
-- API stamps it from the authenticated request; there is no backfill (older
-- rows stay null and are reported as unattributed rather than guessed).

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN     "authorUserId" TEXT;

-- CreateIndex
CREATE INDEX "chat_messages_authorUserId_createdAt_idx" ON "chat_messages"("authorUserId", "createdAt");
