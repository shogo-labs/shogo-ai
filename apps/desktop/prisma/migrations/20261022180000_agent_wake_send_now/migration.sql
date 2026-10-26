-- Migration: agent_wake_send_now
-- Source:    prisma/schema.local.prisma (SQLite)
--
-- A queued team-chat wake is now addressable: it knows the chat session its
-- live run holds (so the session's queue dock can list it), the system note
-- that says it is queued (so that note can follow its state), and whether a
-- person pressed Send now (so the drain takes it ahead of older wakes).
-- Mirrors prisma/migrations/20261022180000_agent_wake_send_now/migration.sql.

-- AlterTable
ALTER TABLE "agent_wakes" ADD COLUMN "chatSessionId" TEXT;
ALTER TABLE "agent_wakes" ADD COLUMN "noteMessageId" TEXT;
ALTER TABLE "agent_wakes" ADD COLUMN "sendNowAt" DATETIME;

-- CreateIndex
CREATE INDEX "agent_wakes_chatSessionId_status_idx" ON "agent_wakes"("chatSessionId", "status");
