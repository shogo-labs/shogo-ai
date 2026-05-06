-- Mirrors prisma/migrations/20260506060000_add_chat_message_mentions (PostgreSQL).
-- SQLite stores JSON columns as TEXT (see prisma/schema.local.prisma).

ALTER TABLE "chat_messages" ADD COLUMN "mentions" TEXT;
