-- Migration: add_background_task_wake_retry
-- Source:    prisma/schema.prisma

-- AlterTable
ALTER TABLE "background_tasks" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "background_tasks_notify_consumed_notifiedAt_idx" ON "background_tasks"("notify", "consumed", "notifiedAt");
