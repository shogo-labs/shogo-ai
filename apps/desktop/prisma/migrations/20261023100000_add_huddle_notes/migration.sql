-- Migration: add_huddle_notes
-- Source:    prisma/schema.local.prisma (SQLite)
--
-- Cloud twin: prisma/migrations/20261023100000_add_huddle_notes

-- AlterTable
ALTER TABLE "huddles" ADD COLUMN "notesEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "huddles" ADD COLUMN "notesMessageId" TEXT;
