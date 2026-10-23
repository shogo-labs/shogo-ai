-- Migration: add_chat_message_tone
-- Adds the message tone preference to chat_user_settings.
-- Mirrors prisma/migrations/20261022100000_add_chat_message_tone.

-- AlterTable
ALTER TABLE "chat_user_settings" ADD COLUMN "messageTone" TEXT NOT NULL DEFAULT 'knock';
