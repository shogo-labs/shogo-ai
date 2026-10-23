-- Migration: add_background_task_held_until
-- Source:    prisma/schema.local.prisma

-- AlterTable
ALTER TABLE "background_tasks" ADD COLUMN "heldUntil" DATETIME;
