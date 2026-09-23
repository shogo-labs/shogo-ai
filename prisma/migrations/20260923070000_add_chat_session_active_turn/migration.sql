ALTER TABLE "chat_sessions"
ADD COLUMN "activeTurnId" TEXT,
ADD COLUMN "activeTurnStartedAt" TIMESTAMP(3),
ADD COLUMN "activeTurnHeartbeatAt" TIMESTAMP(3);

CREATE INDEX "chat_sessions_activeTurnHeartbeatAt_idx"
ON "chat_sessions"("activeTurnHeartbeatAt");
