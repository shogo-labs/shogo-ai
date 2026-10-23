-- Migration: add_huddle_notes_seconds
-- Source:    prisma/schema.local.prisma (SQLite)
--
-- Cloud twin: prisma/migrations/20261023120000_add_huddle_notes_seconds
--
-- Audit of the two transcription paths: how many audio seconds each forwarded
-- to STT for this call. The fallback is the expensive one, so a huddle where
-- notesLivekitSeconds dominates is a call nobody's device could cover.

-- AlterTable
ALTER TABLE "huddles" ADD COLUMN "notesClientSeconds" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "huddles" ADD COLUMN "notesLivekitSeconds" INTEGER NOT NULL DEFAULT 0;
