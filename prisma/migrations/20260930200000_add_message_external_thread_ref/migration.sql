-- AlterTable
ALTER TABLE "conversation_messages" ADD COLUMN "externalThreadRef" TEXT;

-- CreateIndex
CREATE INDEX "conversation_messages_conversationId_externalThreadRef_idx" ON "conversation_messages"("conversationId", "externalThreadRef");
