-- Migration: add_background_task_link
-- Source:    prisma/schema.local.prisma

-- AlterTable
ALTER TABLE "background_tasks" ADD COLUMN "link" TEXT;
