-- Migration: social_conversation_read_marker
-- Source:    prisma/schema.local.prisma
--
-- SQLite mirror of prisma/migrations/20261019170000_social_conversation_read_marker.
-- Unread derives from the read marker, so a backfill sweep counts the history it
-- brings in exactly once instead of trusting a provider counter that lags the
-- events the desktop already applied.

-- AlterTable
ALTER TABLE "social_conversations" ADD COLUMN "lastReadAt" DATETIME;
