-- Migration: social_conversation_read_marker
-- Source:    prisma/schema.prisma
--
-- SHO-71 P4 (QA round 5, B6 follow-up): a thread needs to know when a person
-- last read it, or unread can only ever be an event counter. With the marker,
-- unread is derived — "incoming messages after this instant" — so the backfill
-- sweep can bring in messages we never saw and count them exactly once, instead
-- of either ignoring a thread we already track or trusting a provider counter
-- that lags our own events.

-- AlterTable
ALTER TABLE "social_conversations" ADD COLUMN "lastReadAt" TIMESTAMP(3);
