-- Migration: social_relayed_events
-- Source:    prisma/schema.local.prisma
--
-- SQLite mirror of prisma/migrations/20261019140000_social_relayed_events.
-- A webhook for a desktop's local scope is written down before we answer
-- Zernio, then delivered by the desktop's own poll and acked; `payload` is the
-- JSON-encoded envelope the desktop replays through `applySocialEvent`.

-- CreateTable
CREATE TABLE "social_relayed_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dedupeKey" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "localWorkspaceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventJson" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "social_relayed_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "social_relayed_events_dedupeKey_key" ON "social_relayed_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "social_relayed_events_workspaceId_localWorkspaceId_appliedAt_idx" ON "social_relayed_events"("workspaceId", "localWorkspaceId", "appliedAt");
