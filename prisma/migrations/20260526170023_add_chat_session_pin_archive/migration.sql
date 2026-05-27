-- Migration: add isPinned + isArchived to chat_sessions.
--
-- Pin floats a chat to the top of the history sidebar; archive hides
-- it under a collapsible "Archived" section. See prisma/schema.prisma
-- `ChatSession` and apps/mobile/components/chat/ChatSessionPicker.tsx
-- for how the sidebar groups, sorts, and renders these flags.

-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN "isPinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "chat_sessions" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
