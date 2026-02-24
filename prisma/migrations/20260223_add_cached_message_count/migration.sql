-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN "cachedMessageCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing sessions with user message counts
UPDATE "chat_sessions" cs
SET "cachedMessageCount" = (
  SELECT COUNT(*)
  FROM "chat_messages" cm
  WHERE cm."sessionId" = cs."id"
    AND cm."role" = 'user'
);
