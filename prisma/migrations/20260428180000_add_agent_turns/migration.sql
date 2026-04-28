-- CreateEnum
CREATE TYPE "AgentTurnStatus" AS ENUM ('active', 'completed', 'failed', 'aborted');

-- CreateTable
CREATE TABLE "agent_turns" (
    "id" TEXT NOT NULL,
    "chatSessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "status" "AgentTurnStatus" NOT NULL DEFAULT 'active',
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "messageId" TEXT,

    CONSTRAINT "agent_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_turns_turnId_key" ON "agent_turns"("turnId");

-- CreateIndex
CREATE INDEX "agent_turns_chatSessionId_idx" ON "agent_turns"("chatSessionId");

-- CreateIndex
CREATE INDEX "agent_turns_projectId_idx" ON "agent_turns"("projectId");

-- CreateIndex
CREATE INDEX "agent_turns_turnId_idx" ON "agent_turns"("turnId");

-- CreateIndex
CREATE INDEX "agent_turns_chatSessionId_status_idx" ON "agent_turns"("chatSessionId", "status");

-- AddForeignKey
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_chatSessionId_fkey" FOREIGN KEY ("chatSessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
