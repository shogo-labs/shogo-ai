-- CreateTable
CREATE TABLE "workspace_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'shogo',
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_subscriptions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "eventType" TEXT NOT NULL,
    "eventVersion" INTEGER NOT NULL DEFAULT 1,
    "filter" JSONB,
    "ownerUserId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'shogo',
    "composioTriggerSlug" TEXT,
    "composioTriggerId" TEXT,
    "composioConnectedAccountId" TEXT,
    "composioEntityId" TEXT,
    "triggerConfig" JSONB,
    "target" TEXT NOT NULL DEFAULT 'agent',
    "targetProjectId" TEXT,
    "targetMode" TEXT,
    "prompt" TEXT,
    "notifyConversationId" TEXT,
    "notifyThreadRootId" TEXT,
    "webhookUrl" TEXT,
    "webhookSecret" TEXT,
    "chatSessionId" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_deliveries" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runningAt" TIMESTAMP(3),
    "responseStatus" INTEGER,
    "error" TEXT,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_events_workspaceId_occurredAt_idx" ON "workspace_events"("workspaceId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_events_workspaceId_dedupeKey_key" ON "workspace_events"("workspaceId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "event_subscriptions_composioTriggerId_key" ON "event_subscriptions"("composioTriggerId");

-- CreateIndex
CREATE INDEX "event_subscriptions_workspaceId_enabled_eventType_idx" ON "event_subscriptions"("workspaceId", "enabled", "eventType");

-- CreateIndex
CREATE INDEX "event_subscriptions_ownerUserId_idx" ON "event_subscriptions"("ownerUserId");

-- CreateIndex
CREATE INDEX "event_deliveries_status_nextAttemptAt_idx" ON "event_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "event_deliveries_workspaceId_idx" ON "event_deliveries"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "event_deliveries_subscriptionId_eventId_key" ON "event_deliveries"("subscriptionId", "eventId");

-- AddForeignKey
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "event_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "workspace_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
