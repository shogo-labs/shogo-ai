-- Migration: ChatSession.directKey (SHO-412), SQLite/desktop mirror.
--
-- A person's chat with one agent is a project chat (or a workspace chat for
-- the workspace agent), keyed `a:<workspaceId>:<userId>:<projectId|ws>`.
-- Nullable and additive: existing chats keep `directKey = null`, and SQLite
-- treats nulls as distinct in a unique index.

-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN "directKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "chat_sessions_directKey_key" ON "chat_sessions"("directKey");
