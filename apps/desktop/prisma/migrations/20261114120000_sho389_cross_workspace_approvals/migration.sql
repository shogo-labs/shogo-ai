-- Migration: cross-workspace approvals and audit (SHO-389).
-- Source:    prisma/schema.local.prisma
--
-- The Personal workspace agent may read the person's other workspaces for
-- free and write to them only with a per-call approval.
-- `cross_workspace_approvals` is the row per approved write: minted after the
-- person answers the prompt, spent by the API on the one request that carries
-- its id, so a runtime that skips the prompt cannot write and approving one
-- call does not authorise the next. `cross_workspace_audit` records every
-- cross-workspace call that ran.
--
-- No FK to `workspaces`: the row is short-lived (APPROVAL_TTL_MS) and is
-- written on the side that runs the write, which is not always the side that
-- owns the caller's workspace row.
--
-- Emitted in Prisma's SQLite dialect by
--   prisma migrate diff --from-migrations apps/desktop/prisma/migrations \
--     --to-schema prisma/schema.local.prisma --script

-- CreateTable
CREATE TABLE "cross_workspace_approvals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callerWorkspaceId" TEXT NOT NULL,
    "targetWorkspaceId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "argsHash" TEXT NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "spentAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "cross_workspace_approvals_targetWorkspaceId_status_idx" ON "cross_workspace_approvals"("targetWorkspaceId", "status");

-- CreateTable
CREATE TABLE "cross_workspace_audit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callerWorkspaceId" TEXT NOT NULL,
    "targetWorkspaceId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "approvalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "cross_workspace_audit_targetWorkspaceId_createdAt_idx" ON "cross_workspace_audit"("targetWorkspaceId", "createdAt");
