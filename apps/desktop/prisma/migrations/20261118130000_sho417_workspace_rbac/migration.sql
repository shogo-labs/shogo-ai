-- Migration: SHO-417 Workspace RBAC (AccessPolicy + AccessAuditEvent)
-- Source:    prisma/schema.local.prisma
--
-- SQLite mirror of prisma/migrations/20261118130000_sho417_workspace_rbac.
-- Additive and empty on deploy: no policy rows means every role keeps its
-- built-in default, which is today's behaviour. Nothing is backfilled.
--
-- `subjectId` is polymorphic (role name | user_groups.id | users.id), so it
-- carries no foreign key; the workspace FK cascades the rows away with the
-- workspace. Group and member deletes clean their rows up in the service.

-- CreateTable
CREATE TABLE "access_policies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "abilities" TEXT,
    "modelTiers" TEXT,
    "modelIds" TEXT,
    "defaultModelId" TEXT,
    "spendCapUsd" REAL,
    "spendPeriod" TEXT,
    "requestsPerHour" INTEGER,
    "updatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "access_policies_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "access_audit_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "onBehalfOfUserId" TEXT,
    "kind" TEXT NOT NULL,
    "permission" TEXT,
    "modelId" TEXT,
    "subject" TEXT,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "access_audit_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "access_policies_workspaceId_subjectType_subjectId_key" ON "access_policies"("workspaceId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "access_policies_workspaceId_idx" ON "access_policies"("workspaceId");

-- CreateIndex
CREATE INDEX "access_audit_events_workspaceId_createdAt_idx" ON "access_audit_events"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "access_audit_events_workspaceId_kind_createdAt_idx" ON "access_audit_events"("workspaceId", "kind", "createdAt");
