-- Migration: add_chat_activity_push_settings
-- Adds the Activity and phone push timing preferences to chat_user_settings.
-- Mirrors prisma/migrations/20261019130000_add_chat_activity_push_settings.

-- AlterTable
ALTER TABLE "chat_user_settings" ADD COLUMN "dmInActivity" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "chat_user_settings" ADD COLUMN "threadRepliesInBadge" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "chat_user_settings" ADD COLUMN "mobilePushDelay" TEXT NOT NULL DEFAULT 'inactive';
