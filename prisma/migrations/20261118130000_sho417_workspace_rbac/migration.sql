-- Migration: Workspace RBAC (SHO-417) — AccessPolicy + AccessAuditEvent.
--
-- Admins decide which models and which agent abilities each role, group and
-- member can use. `access_policies` holds the grants; the resolver unions the
-- member's role, group and own rows and intersects the result with the
-- workspace ceiling (`workspace_model_visibility`). Grants only add, so there
-- is no precedence to reason about.
--
-- Additive and empty on deploy: no policy rows means every role keeps its
-- built-in default, which is today's behaviour. Nothing is backfilled.
--
-- `subject_id` is polymorphic (role name | user_groups.id | users.id), so it
-- carries no foreign key; the workspace FK cascades the rows away with the
-- workspace. Group and member deletes clean their rows up in the service.

-- CreateTable
CREATE TABLE "access_policies" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "abilities" JSONB,
    "modelTiers" JSONB,
    "modelIds" JSONB,
    "defaultModelId" TEXT,
    "spendCapUsd" DOUBLE PRECISION,
    "spendPeriod" TEXT,
    "requestsPerHour" INTEGER,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_audit_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "onBehalfOfUserId" TEXT,
    "kind" TEXT NOT NULL,
    "permission" TEXT,
    "modelId" TEXT,
    "subject" JSONB,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_policies_workspaceId_subjectType_subjectId_key" ON "access_policies"("workspaceId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "access_policies_workspaceId_idx" ON "access_policies"("workspaceId");

-- CreateIndex
CREATE INDEX "access_audit_events_workspaceId_createdAt_idx" ON "access_audit_events"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "access_audit_events_workspaceId_kind_createdAt_idx" ON "access_audit_events"("workspaceId", "kind", "createdAt");

-- AddForeignKey
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_audit_events" ADD CONSTRAINT "access_audit_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
