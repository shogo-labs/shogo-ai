-- Migration: add_huddle_notes
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same columns, SQLite)
--
-- Every huddle records notes: a speaker-labelled transcript and, when it ends,
-- an auto summary. `notesEnabled` is the call-wide toggle any participant may
-- flip; `notesMessageId` is claimed once so exactly one pod posts the summary.

-- AlterTable
ALTER TABLE "huddles" ADD COLUMN "notesEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "notesMessageId" TEXT;
