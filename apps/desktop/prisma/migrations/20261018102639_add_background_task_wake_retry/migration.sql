-- Migration: add_background_task_wake_retry
-- Source:    prisma/schema.local.prisma

-- AlterTable
ALTER TABLE "background_tasks" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "background_tasks" ADD COLUMN "nextAttemptAt" DATETIME;

-- CreateIndex
CREATE INDEX "background_tasks_notify_consumed_notifiedAt_idx" ON "background_tasks"("notify", "consumed", "notifiedAt");
