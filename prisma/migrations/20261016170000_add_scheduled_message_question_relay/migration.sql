-- AlterTable
ALTER TABLE "scheduled_messages" ADD COLUMN     "questionMessageId" TEXT;

-- CreateIndex
CREATE INDEX "scheduled_messages_questionMessageId_userId_status_idx" ON "scheduled_messages"("questionMessageId", "userId", "status");
