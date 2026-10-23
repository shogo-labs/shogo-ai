-- Migration: add_chat_notification_sounds
-- Adds the message and huddle sound preferences to chat_user_settings.
-- Mirrors prisma/migrations/20261019120000_add_chat_notification_sounds.
-- Hand-trimmed from the generator output: the generated file also redefined
-- chat_user_settings and an unrelated signup_attributions index, which are
-- not part of this change.

-- AlterTable
ALTER TABLE "chat_user_settings" ADD COLUMN "messageSound" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "chat_user_settings" ADD COLUMN "huddleSound" TEXT NOT NULL DEFAULT 'ring';
