-- Migration: add_agent_wakes
-- Source:    prisma/schema.local.prisma (SQLite)
--
-- One live run per (agent, thread): a wake that arrives while the agent is
-- already working that thread waits here until the live reply ends, instead of
-- starting a second run on the same session (which made one Stop kill both).
-- Mirrors prisma/migrations/20261019210000_add_agent_wakes/migration.sql.

-- CreateTable
CREATE TABLE "agent_wakes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "threadRootId" TEXT,
    "triggerMessageId" TEXT NOT NULL,
    "agentRef" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chain" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_wakes_triggerMessageId_agentRef_key" ON "agent_wakes"("triggerMessageId", "agentRef");

-- CreateIndex
CREATE INDEX "agent_wakes_conversationId_threadRootId_agentRef_status_idx" ON "agent_wakes"("conversationId", "threadRootId", "agentRef", "status");

-- CreateIndex
CREATE INDEX "agent_wakes_status_createdAt_idx" ON "agent_wakes"("status", "createdAt");
