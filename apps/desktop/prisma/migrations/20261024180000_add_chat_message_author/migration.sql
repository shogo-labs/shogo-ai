-- Migration: add_chat_message_author
-- Generated: 2026-10-24 by hand for the desktop (SQLite) track.
-- Cloud twin: prisma/migrations/20261024180000_add_chat_message_author
--
-- Same column and index as the PG migration; SQLite spells the type TEXT and
-- takes the index in the same statement batch. No backfill.

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN "authorUserId" TEXT;

-- CreateIndex
CREATE INDEX "chat_messages_authorUserId_createdAt_idx" ON "chat_messages"("authorUserId", "createdAt");
