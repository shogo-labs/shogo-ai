-- Migration: machine_workspaces
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same columns, SQLite)
--
-- A paired desktop keeps writing its own SQLite database; the cloud keeps a
-- copy of those records in the normal tables, with the desktop's ids unchanged.
-- `workspaces.machineInstanceId` marks the copied workspace so one guard can
-- refuse cloud writes to it and make every cloud background job skip it.
-- `machine_mirror_rows` records which machine sent each copied row, which is
-- what makes "a desktop can't overwrite a row it doesn't own" checkable and
-- what makes deleting a machine's copy exact.
-- `machine_sync_changes` is the desktop change log written by SQLite triggers;
-- it stays empty in the cloud but must exist on both tracks for schema parity.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "machineInstanceId" TEXT;

-- CreateTable
CREATE TABLE "machine_sync_states" (
    "instanceId" TEXT NOT NULL,
    "epoch" TEXT NOT NULL DEFAULT '',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "lastIngestAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machine_sync_states_pkey" PRIMARY KEY ("instanceId")
);

-- CreateTable
CREATE TABLE "machine_mirror_rows" (
    "model" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "epoch" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_mirror_rows_pkey" PRIMARY KEY ("model","recordId")
);

-- CreateTable
CREATE TABLE "machine_sync_changes" (
    "seq" SERIAL NOT NULL,
    "model" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_sync_changes_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "workspaces_machineInstanceId_idx" ON "workspaces"("machineInstanceId");

-- CreateIndex
CREATE INDEX "machine_mirror_rows_instanceId_idx" ON "machine_mirror_rows"("instanceId");

-- CreateIndex
CREATE INDEX "machine_mirror_rows_instanceId_model_idx" ON "machine_mirror_rows"("instanceId", "model");

-- CreateIndex
CREATE INDEX "machine_sync_changes_createdAt_idx" ON "machine_sync_changes"("createdAt");
