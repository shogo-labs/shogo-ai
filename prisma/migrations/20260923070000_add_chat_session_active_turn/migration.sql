ALTER TABLE "chat_sessions"
ADD COLUMN "activeTurnId" TEXT,
ADD COLUMN "activeTurnStartedAt" TIMESTAMP(3);

CREATE INDEX "chat_sessions_workspaceId_activeTurnStartedAt_idx"
ON "chat_sessions"("workspaceId", "activeTurnStartedAt");
