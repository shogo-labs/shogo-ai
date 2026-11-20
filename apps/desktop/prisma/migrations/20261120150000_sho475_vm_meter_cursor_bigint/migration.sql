-- SHO-475: agentMs / appMs / idleMs overflow int32 after 24.8 days.
-- SQLite does not support ALTER COLUMN type changes; redeclare the table.

-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_vm_meter_cursors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostId" TEXT NOT NULL,
    "vmId" TEXT NOT NULL,
    "assignedAt" BIGINT NOT NULL,
    "agentMs" BIGINT NOT NULL DEFAULT 0,
    "appMs" BIGINT NOT NULL DEFAULT 0,
    "idleMs" BIGINT NOT NULL DEFAULT 0,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_vm_meter_cursors" SELECT "id", "hostId", "vmId", "assignedAt", "agentMs", "appMs", "idleMs", "lastSeenAt", "updatedAt" FROM "vm_meter_cursors";
DROP TABLE "vm_meter_cursors";
ALTER TABLE "new_vm_meter_cursors" RENAME TO "vm_meter_cursors";
CREATE UNIQUE INDEX "vm_meter_cursors_hostId_vmId_assignedAt_key" ON "vm_meter_cursors"("hostId", "vmId", "assignedAt");
CREATE INDEX "vm_meter_cursors_lastSeenAt_idx" ON "vm_meter_cursors"("lastSeenAt");
PRAGMA foreign_keys=ON;
