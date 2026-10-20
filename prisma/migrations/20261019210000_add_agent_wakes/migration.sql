-- Migration: add_agent_wakes
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same columns, JSON stored as TEXT)
--
-- One live run per (agent, thread): a wake that arrives while the agent is
-- already working that thread waits here until the live reply ends, instead of
-- starting a second run on the same session (which made one Stop kill both).

-- CreateTable
CREATE TABLE "agent_wakes" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "threadRootId" TEXT,
    "triggerMessageId" TEXT NOT NULL,
    "agentRef" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chain" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_wakes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_wakes_triggerMessageId_agentRef_key" ON "agent_wakes"("triggerMessageId", "agentRef");

-- CreateIndex
CREATE INDEX "agent_wakes_conversationId_threadRootId_agentRef_status_idx" ON "agent_wakes"("conversationId", "threadRootId", "agentRef", "status");

-- CreateIndex
CREATE INDEX "agent_wakes_status_createdAt_idx" ON "agent_wakes"("status", "createdAt");
