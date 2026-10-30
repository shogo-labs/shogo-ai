-- Migration: chat_message_updated_at
-- Desktop:   apps/desktop/prisma/migrations/20261030120000_chat_message_updated_at
--
-- Assistant rows are rewritten in place while a reply streams, and team-chat
-- rows are rewritten by an edit, a soft delete or a reaction. A client that
-- keeps history on the device therefore needs a change cursor that sees those
-- in-place writes; `createdAt` alone only sees brand-new rows. Backfilled from
-- `createdAt` so an upgrade never reports older history as "changed".

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill
UPDATE "chat_messages" SET "updatedAt" = "createdAt";

-- CreateIndex
CREATE INDEX "chat_messages_sessionId_updatedAt_idx" ON "chat_messages"("sessionId", "updatedAt");
