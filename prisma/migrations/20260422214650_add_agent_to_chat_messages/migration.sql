-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN     "agent" TEXT NOT NULL DEFAULT 'technical';

-- CreateIndex
CREATE INDEX "chat_messages_sessionId_agent_createdAt_idx" ON "chat_messages"("sessionId", "agent", "createdAt");
