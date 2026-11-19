-- Migration: VM compute metering (SHO-424).
--
-- What a workspace actually ran, hour by hour: microVM running time × the
-- machine size the host booted, split by liveness class (agent turn / app
-- traffic / idle tail) and by why the VM was started. Ingested from the metal
-- hosts' heartbeats and priced by jobs/vm-usage-bill.ts, shadow mode first.
--
-- Two new tables, no backfill: there is no run history to migrate (runs lived
-- only in Redis and on the hosts), so instrumentation starts at zero and the
-- first full hour is the first row. DDL only, so this is replication-safe on
-- both regions (RUNBOOK §3: no cross-table writes, no backfill UPDATE).
--
-- `hostId` is in the usage unique key because a host reports to exactly one
-- region: the two regions' write sets stay disjoint and logical replication
-- never sees an insert_exists conflict (SHO-344/345).
-- `projectId` defaults to '' rather than NULL so that key is total — a NULL
-- makes a Postgres unique index non-enforcing for that row, and two replicas
-- would each insert "the same" hour instead of incrementing one.

-- CreateTable
CREATE TABLE "vm_usage_hours" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT '',
    "hour" TIMESTAMP(3) NOT NULL,
    "hostId" TEXT NOT NULL,
    "vcpus" INTEGER NOT NULL,
    "memMiB" INTEGER NOT NULL,
    "cause" TEXT NOT NULL DEFAULT 'user_open',
    "agentSeconds" INTEGER NOT NULL DEFAULT 0,
    "appSeconds" INTEGER NOT NULL DEFAULT 0,
    "idleSeconds" INTEGER NOT NULL DEFAULT 0,
    "chargedUsd" DOUBLE PRECISION,
    "billedAt" TIMESTAMP(3),

    CONSTRAINT "vm_usage_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vm_meter_cursors" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "vmId" TEXT NOT NULL,
    "assignedAt" BIGINT NOT NULL,
    "agentMs" INTEGER NOT NULL DEFAULT 0,
    "appMs" INTEGER NOT NULL DEFAULT 0,
    "idleMs" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vm_meter_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vm_usage_hours_workspaceId_projectId_hour_hostId_vcpus_memMiB_cause_key" ON "vm_usage_hours"("workspaceId", "projectId", "hour", "hostId", "vcpus", "memMiB", "cause");
CREATE INDEX "vm_usage_hours_workspaceId_hour_idx" ON "vm_usage_hours"("workspaceId", "hour");
CREATE INDEX "vm_usage_hours_billedAt_idx" ON "vm_usage_hours"("billedAt");
CREATE INDEX "vm_usage_hours_hour_idx" ON "vm_usage_hours"("hour");

-- CreateIndex
CREATE UNIQUE INDEX "vm_meter_cursors_hostId_vmId_assignedAt_key" ON "vm_meter_cursors"("hostId", "vmId", "assignedAt");
CREATE INDEX "vm_meter_cursors_lastSeenAt_idx" ON "vm_meter_cursors"("lastSeenAt");
