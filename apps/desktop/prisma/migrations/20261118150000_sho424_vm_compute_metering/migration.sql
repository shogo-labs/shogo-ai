-- Migration: SHO-424 VM compute metering
-- Source:    prisma/schema.local.prisma
--
-- Desktop-track mirror of the cloud migration. The tables exist so both tracks
-- carry the same shape (the schema-parity check and the channel's
-- desktop/cloud divergence rule require it); local mode never writes them —
-- compute billing is a cloud concern and the hourly job no-ops locally, exactly
-- like published-app usage.

-- CreateTable
CREATE TABLE "vm_usage_hours" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT '',
    "hour" DATETIME NOT NULL,
    "hostId" TEXT NOT NULL,
    "vcpus" INTEGER NOT NULL,
    "memMiB" INTEGER NOT NULL,
    "cause" TEXT NOT NULL DEFAULT 'user_open',
    "agentSeconds" INTEGER NOT NULL DEFAULT 0,
    "appSeconds" INTEGER NOT NULL DEFAULT 0,
    "idleSeconds" INTEGER NOT NULL DEFAULT 0,
    "chargedUsd" REAL,
    "billedAt" DATETIME
);

-- CreateTable
CREATE TABLE "vm_meter_cursors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostId" TEXT NOT NULL,
    "vmId" TEXT NOT NULL,
    "assignedAt" BIGINT NOT NULL,
    "agentMs" INTEGER NOT NULL DEFAULT 0,
    "appMs" INTEGER NOT NULL DEFAULT 0,
    "idleMs" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "vm_usage_hours_workspaceId_projectId_hour_hostId_vcpus_memMiB_cause_key" ON "vm_usage_hours"("workspaceId", "projectId", "hour", "hostId", "vcpus", "memMiB", "cause");
CREATE INDEX "vm_usage_hours_workspaceId_hour_idx" ON "vm_usage_hours"("workspaceId", "hour");
CREATE INDEX "vm_usage_hours_billedAt_idx" ON "vm_usage_hours"("billedAt");
CREATE INDEX "vm_usage_hours_hour_idx" ON "vm_usage_hours"("hour");

-- CreateIndex
CREATE UNIQUE INDEX "vm_meter_cursors_hostId_vmId_assignedAt_key" ON "vm_meter_cursors"("hostId", "vmId", "assignedAt");
CREATE INDEX "vm_meter_cursors_lastSeenAt_idx" ON "vm_meter_cursors"("lastSeenAt");
