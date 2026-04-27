-- Add post-call transcript fields to voice_call_meters.
-- SQLite has no native JSON; stored as TEXT and parsed by the API layer.

ALTER TABLE "voice_call_meters" ADD COLUMN "transcript" TEXT;
ALTER TABLE "voice_call_meters" ADD COLUMN "transcriptSummary" TEXT;
