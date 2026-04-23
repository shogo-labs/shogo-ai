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
    "agent" TEXT NOT NULL DEFAULT 'technical',
    CONSTRAINT "chat_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_chat_messages" ("content", "createdAt", "id", "imageData", "parts", "role", "sessionId") SELECT "content", "createdAt", "id", "imageData", "parts", "role", "sessionId" FROM "chat_messages";
DROP TABLE "chat_messages";
ALTER TABLE "new_chat_messages" RENAME TO "chat_messages";
CREATE INDEX "chat_messages_sessionId_idx" ON "chat_messages"("sessionId");
CREATE INDEX "chat_messages_sessionId_createdAt_idx" ON "chat_messages"("sessionId", "createdAt");
CREATE INDEX "chat_messages_sessionId_agent_createdAt_idx" ON "chat_messages"("sessionId", "agent", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

