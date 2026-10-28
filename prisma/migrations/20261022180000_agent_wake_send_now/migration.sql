-- Migration: agent_wake_send_now
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same columns, SQLite)
--
-- A queued team-chat wake is now addressable: it knows the chat session its
-- live run holds (so the session's queue dock can list it), the system note
-- that says it is queued (so that note can follow its state), and whether a
-- person pressed Send now (so the drain takes it ahead of older wakes).

-- AlterTable
ALTER TABLE "agent_wakes" ADD COLUMN     "chatSessionId" TEXT,
ADD COLUMN     "noteMessageId" TEXT,
ADD COLUMN     "sendNowAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "agent_wakes_chatSessionId_status_idx" ON "agent_wakes"("chatSessionId", "status");
