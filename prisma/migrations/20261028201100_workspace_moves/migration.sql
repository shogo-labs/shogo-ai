-- Migration: workspace_moves
-- Desktop:   apps/desktop/prisma/migrations/20261028201058_workspace_moves
--
-- A desktop <-> cloud workspace move is a long job (a 19 GB workspace takes
-- hours), so it cannot live in a request: `workspace_moves` is the row the
-- driver advances phase by phase and resumes from after a restart.
--
-- `workspaces.movedToWorkspaceId` / `movedAt` are the other half of the
-- decision that the source is kept: the old workspace stays readable and shows
-- a "Moved to <target>" banner instead of being deleted.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "movedToWorkspaceId" TEXT,
ADD COLUMN     "movedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "workspace_moves" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "sourceWorkspaceId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "targetWorkspaceId" TEXT,
    "targetName" TEXT,
    "selection" JSONB NOT NULL,
    "plan" JSONB,
    "progress" JSONB,
    "idMap" JSONB,
    "handover" JSONB,
    "rowsCopied" INTEGER NOT NULL DEFAULT 0,
    "filesCopied" INTEGER NOT NULL DEFAULT 0,
    "bytesCopied" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,
    "switchedOverAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_moves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_moves_workspaceId_createdAt_idx" ON "workspace_moves"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_moves_status_idx" ON "workspace_moves"("status");
