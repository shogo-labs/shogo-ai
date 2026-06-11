-- AlterTable
-- BETA: per-chat git worktrees. Mirror the runtime worktree lifecycle onto the
-- ChatSession so the UI can render the branch chip + merge state across reloads.
ALTER TABLE "chat_sessions" ADD COLUMN     "worktreeBranch" TEXT,
ADD COLUMN     "worktreeStatus" TEXT,
ADD COLUMN     "worktreePath" TEXT;
