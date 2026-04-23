-- Add post-call transcript fields to voice_call_meters.
-- Populated by the ElevenLabs post_call_transcription webhook.

ALTER TABLE "voice_call_meters" ADD COLUMN "transcript" JSONB;
ALTER TABLE "voice_call_meters" ADD COLUMN "transcriptSummary" TEXT;
