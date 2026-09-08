-- CreateTable
CREATE TABLE "message_feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "thumbs" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_feedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "chat_messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "message_feedback_messageId_idx" ON "message_feedback"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "message_feedback_messageId_userId_key" ON "message_feedback"("messageId", "userId");
