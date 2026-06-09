-- Migration: add_chat_session_worktree
-- Source:    prisma/schema.local.prisma
--
-- BETA: per-chat git worktrees. Mirror the runtime worktree lifecycle onto the
-- ChatSession so the UI can render the branch chip + merge state across reloads.
-- Scoped to ALTER ADD COLUMN so it touches only this table.

ALTER TABLE "chat_sessions" ADD COLUMN "worktreeBranch" TEXT;
ALTER TABLE "chat_sessions" ADD COLUMN "worktreeStatus" TEXT;
ALTER TABLE "chat_sessions" ADD COLUMN "worktreePath" TEXT;
