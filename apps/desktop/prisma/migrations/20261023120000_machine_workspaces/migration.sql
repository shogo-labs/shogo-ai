-- Migration: machine_workspaces
-- Source:    prisma/schema.local.prisma (SQLite)
--
-- The desktop sends its records to the cloud, so it needs three things the
-- cloud also has: the workspace tag that says "the cloud only holds a copy",
-- the change log its triggers write to, and the bookkeeping rows the cloud uses
-- (kept here only so the two schemas stay identical — the desktop never writes
-- `machine_sync_states` / `machine_mirror_rows`).
-- Mirrors prisma/migrations/20261023120000_machine_workspaces/migration.sql.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "machineInstanceId" TEXT;

-- CreateTable
CREATE TABLE "machine_sync_states" (
    "instanceId" TEXT NOT NULL PRIMARY KEY,
    "epoch" TEXT NOT NULL DEFAULT '',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "lastIngestAt" DATETIME,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "machine_mirror_rows" (
    "model" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "epoch" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("model", "recordId")
);

-- CreateTable
CREATE TABLE "machine_sync_changes" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "model" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "workspaces_machineInstanceId_idx" ON "workspaces"("machineInstanceId");

-- CreateIndex
CREATE INDEX "machine_mirror_rows_instanceId_idx" ON "machine_mirror_rows"("instanceId");

-- CreateIndex
CREATE INDEX "machine_mirror_rows_instanceId_model_idx" ON "machine_mirror_rows"("instanceId", "model");

-- CreateIndex
CREATE INDEX "machine_sync_changes_createdAt_idx" ON "machine_sync_changes"("createdAt");
