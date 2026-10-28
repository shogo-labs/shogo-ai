-- AlterTable
ALTER TABLE "chat_queued_messages" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'user';

-- CreateTable
CREATE TABLE "background_tasks" (
    "id" TEXT NOT NULL,
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
    "notifiedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "background_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "background_tasks_source_targetRef_status_idx" ON "background_tasks"("source", "targetRef", "status");

-- CreateIndex
CREATE INDEX "background_tasks_chatSessionId_status_idx" ON "background_tasks"("chatSessionId", "status");

-- CreateIndex
CREATE INDEX "background_tasks_expiresAt_idx" ON "background_tasks"("expiresAt");

