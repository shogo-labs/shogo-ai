-- Migration: add_background_tasks
-- Source:    prisma/schema.local.prisma
--
-- Generated with `prisma migrate diff`, with the chat_queued_messages table
-- rebuild replaced by a plain ADD COLUMN (SQLite accepts NOT NULL with a default).

-- AlterTable
ALTER TABLE "chat_queued_messages" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'user';

-- CreateTable
CREATE TABLE "background_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatSessionId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "targetRef" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "output" TEXT NOT NULL DEFAULT '',
    "summary" TEXT,
    "until" TEXT,
    "note" TEXT,
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "notifiedAt" DATETIME,
    "finishedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- CreateIndex
CREATE INDEX "background_tasks_source_targetRef_status_idx" ON "background_tasks"("source", "targetRef", "status");

-- CreateIndex
CREATE INDEX "background_tasks_chatSessionId_status_idx" ON "background_tasks"("chatSessionId", "status");

-- CreateIndex
CREATE INDEX "background_tasks_expiresAt_idx" ON "background_tasks"("expiresAt");
