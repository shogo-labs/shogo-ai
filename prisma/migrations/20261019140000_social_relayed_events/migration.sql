-- Migration: social_relayed_events
-- Source:    prisma/schema.prisma
--
-- A webhook for a desktop's local scope is written down before we answer
-- Zernio, then delivered by the desktop's own poll and acked. Zernio retries
-- only the deliveries it saw fail, so an event acknowledged into an in-memory
-- log would be lost if the desktop was offline or the poll hit another replica.

-- CreateTable
CREATE TABLE "social_relayed_events" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "localWorkspaceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventJson" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_relayed_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_relayed_events_dedupeKey_key" ON "social_relayed_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "social_relayed_events_workspaceId_localWorkspaceId_appliedAt_idx" ON "social_relayed_events"("workspaceId", "localWorkspaceId", "appliedAt");

-- AddForeignKey
ALTER TABLE "social_relayed_events" ADD CONSTRAINT "social_relayed_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
