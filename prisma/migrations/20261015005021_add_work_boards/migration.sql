-- AlterTable
ALTER TABLE "event_subscriptions" ADD COLUMN     "workItemTarget" JSONB;

-- CreateTable
CREATE TABLE "boards" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "itemCounter" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "itemType" TEXT NOT NULL DEFAULT 'task',
    "description" TEXT,
    "fieldsSchema" JSONB,
    "postToChannel" TEXT NOT NULL DEFAULT 'all',
    "requiresHumanReview" BOOLEAN NOT NULL DEFAULT false,
    "defaultAssigneeAgentRef" TEXT,
    "managedBy" TEXT NOT NULL DEFAULT 'user',
    "systemManagedBy" TEXT,
    "templateId" TEXT,
    "createdById" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_columns" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL DEFAULT 'active',
    "wipLimit" INTEGER,
    "agentRef" TEXT,
    "slaHours" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_items" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "columnId" TEXT NOT NULL,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "key" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "fields" JSONB,
    "priority" TEXT NOT NULL DEFAULT 'none',
    "assigneeUserId" TEXT,
    "assigneeAgentRef" TEXT,
    "dueAt" TIMESTAMP(3),
    "goalId" TEXT,
    "projectId" TEXT,
    "conversationId" TEXT,
    "threadRootMessageId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "externalRef" TEXT,
    "eventSubscriptionId" TEXT,
    "fingerprint" TEXT,
    "historySummary" TEXT,
    "historySummaryAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByAgentRef" TEXT,
    "columnEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_events" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorAgentRef" TEXT,
    "sessionId" TEXT,
    "eventData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_links" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "conversationId" TEXT,
    "reason" TEXT NOT NULL,
    "addedByUserId" TEXT,
    "addedByAgentRef" TEXT,
    "snippet" TEXT,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_subscriptions" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "problem_occurrences" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "environment" TEXT,
    "release" TEXT,
    "message" TEXT,
    "stack" TEXT,
    "url" TEXT,
    "userRef" TEXT,
    "occurrenceContext" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "problem_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "boards_conversationId_position_idx" ON "boards"("conversationId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "boards_workspaceId_slug_key" ON "boards"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "board_columns_boardId_position_idx" ON "board_columns"("boardId", "position");

-- CreateIndex
CREATE INDEX "work_items_boardId_columnId_position_idx" ON "work_items"("boardId", "columnId", "position");

-- CreateIndex
CREATE INDEX "work_items_workspaceId_assigneeUserId_idx" ON "work_items"("workspaceId", "assigneeUserId");

-- CreateIndex
CREATE INDEX "work_items_workspaceId_assigneeAgentRef_idx" ON "work_items"("workspaceId", "assigneeAgentRef");

-- CreateIndex
CREATE INDEX "work_items_workspaceId_fingerprint_idx" ON "work_items"("workspaceId", "fingerprint");

-- CreateIndex
CREATE INDEX "work_items_threadRootMessageId_idx" ON "work_items"("threadRootMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "work_items_workspaceId_key_key" ON "work_items"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "work_item_events_workItemId_createdAt_idx" ON "work_item_events"("workItemId", "createdAt");

-- CreateIndex
CREATE INDEX "work_item_events_workspaceId_createdAt_idx" ON "work_item_events"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "work_item_links_kind_refId_idx" ON "work_item_links"("kind", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_links_workItemId_kind_refId_key" ON "work_item_links"("workItemId", "kind", "refId");

-- CreateIndex
CREATE INDEX "work_item_subscriptions_userId_idx" ON "work_item_subscriptions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_subscriptions_workItemId_userId_key" ON "work_item_subscriptions"("workItemId", "userId");

-- CreateIndex
CREATE INDEX "problem_occurrences_workItemId_occurredAt_idx" ON "problem_occurrences"("workItemId", "occurredAt");

-- CreateIndex
CREATE INDEX "problem_occurrences_workspaceId_fingerprint_idx" ON "problem_occurrences"("workspaceId", "fingerprint");

-- AddForeignKey
ALTER TABLE "boards" ADD CONSTRAINT "boards_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boards" ADD CONSTRAINT "boards_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "board_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_events" ADD CONSTRAINT "work_item_events_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_links" ADD CONSTRAINT "work_item_links_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_subscriptions" ADD CONSTRAINT "work_item_subscriptions_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_occurrences" ADD CONSTRAINT "problem_occurrences_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

