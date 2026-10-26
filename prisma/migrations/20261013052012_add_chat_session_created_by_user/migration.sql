-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN "createdByUserId" TEXT;

-- CreateIndex
CREATE INDEX "chat_sessions_workspaceId_createdByUserId_lastActiveAt_idx" ON "chat_sessions"("workspaceId", "createdByUserId", "lastActiveAt");
