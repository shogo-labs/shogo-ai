-- CreateTable
CREATE TABLE "chat_queued_messages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "content" TEXT NOT NULL,
    "parts" TEXT,
    "body" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "chat_queued_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_queued_messages_sessionId_status_position_idx"
    ON "chat_queued_messages"("sessionId", "status", "position");

-- CreateIndex
CREATE INDEX "chat_queued_messages_sessionId_createdAt_idx"
    ON "chat_queued_messages"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "chat_queued_messages"
    ADD CONSTRAINT "chat_queued_messages_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
