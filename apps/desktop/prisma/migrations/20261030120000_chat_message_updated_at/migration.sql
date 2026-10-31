-- Migration: chat_message_updated_at
-- Cloud:     prisma/migrations/20261030120000_chat_message_updated_at
--
-- See the Postgres migration for the reasoning. SQLite rejects ADD COLUMN with
-- a non-constant default (`CURRENT_TIMESTAMP`) on a non-empty table, so the
-- table is redefined instead. Every existing row's `updatedAt` is copied from
-- its own `createdAt` so an upgrade does not report old history as new.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_chat_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "imageData" TEXT,
    "parts" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent" TEXT NOT NULL DEFAULT 'technical',
    "model" TEXT,
    "authorUserId" TEXT,
    CONSTRAINT "chat_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_chat_messages" ("agent", "authorUserId", "content", "createdAt", "id", "imageData", "model", "parts", "role", "sessionId", "updatedAt") SELECT "agent", "authorUserId", "content", "createdAt", "id", "imageData", "model", "parts", "role", "sessionId", "createdAt" FROM "chat_messages";
DROP TABLE "chat_messages";
ALTER TABLE "new_chat_messages" RENAME TO "chat_messages";
CREATE INDEX "chat_messages_sessionId_idx" ON "chat_messages"("sessionId");
CREATE INDEX "chat_messages_sessionId_createdAt_idx" ON "chat_messages"("sessionId", "createdAt");
CREATE INDEX "chat_messages_sessionId_agent_createdAt_idx" ON "chat_messages"("sessionId", "agent", "createdAt");
CREATE INDEX "chat_messages_sessionId_updatedAt_idx" ON "chat_messages"("sessionId", "updatedAt");
CREATE INDEX "chat_messages_authorUserId_createdAt_idx" ON "chat_messages"("authorUserId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
