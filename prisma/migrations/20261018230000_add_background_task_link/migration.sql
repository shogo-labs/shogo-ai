-- Migration: add_background_task_link
-- Source:    prisma/schema.prisma

-- AlterTable
ALTER TABLE "background_tasks" ADD COLUMN     "link" JSONB;
