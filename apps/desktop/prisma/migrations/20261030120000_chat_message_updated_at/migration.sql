-- Migration: chat_message_updated_at
-- Cloud:     prisma/migrations/20261030120000_chat_message_updated_at
--
-- See the Postgres migration for the reasoning. `CURRENT_TIMESTAMP` is allowed
-- as an ADD COLUMN default in SQLite, then every existing row is backfilled
-- from its own `createdAt` so an upgrade does not report old history as new.

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill
UPDATE "chat_messages" SET "updatedAt" = "createdAt";

-- CreateIndex
CREATE INDEX "chat_messages_sessionId_updatedAt_idx" ON "chat_messages"("sessionId", "updatedAt");
