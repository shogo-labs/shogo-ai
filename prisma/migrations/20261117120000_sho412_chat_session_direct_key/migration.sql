-- Migration: ChatSession.directKey (SHO-412).
--
-- A person's chat with one agent is a project chat (or a workspace chat for
-- the workspace agent), keyed `a:<workspaceId>:<userId>:<projectId|ws>` — the
-- key the agent DM it replaces used, with the workspace prefixed so it stays
-- unique for a person who belongs to several workspaces.
--
-- Nullable and additive: every existing chat keeps `directKey = null`, and the
-- unique index tolerates any number of nulls.

-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN "directKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "chat_sessions_directKey_key" ON "chat_sessions"("directKey");
