-- Migration: work_item_pr_state
-- Source:    prisma/schema.local.prisma
--
-- Cards that know their PR: a linked PR keeps its own live state (checks,
-- armed/queued, merged), and a column can declare that arming is allowed
-- from it.

-- AlterTable
ALTER TABLE "board_columns" ADD COLUMN "rules" TEXT;

-- AlterTable
ALTER TABLE "work_item_links" ADD COLUMN "metadata" TEXT;
ALTER TABLE "work_item_links" ADD COLUMN "syncedAt" DATETIME;
