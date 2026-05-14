
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_instances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "os" TEXT,
    "arch" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'desktop',
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastSeenAt" DATETIME,
    "wsRequestedAt" DATETIME,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "instances_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_instances" ("arch", "createdAt", "hostname", "id", "lastSeenAt", "metadata", "name", "os", "status", "updatedAt", "workspaceId", "wsRequestedAt") SELECT "arch", "createdAt", "hostname", "id", "lastSeenAt", "metadata", "name", "os", "status", "updatedAt", "workspaceId", "wsRequestedAt" FROM "instances";
DROP TABLE "instances";
ALTER TABLE "new_instances" RENAME TO "instances";
CREATE INDEX "instances_workspaceId_idx" ON "instances"("workspaceId");
CREATE INDEX "instances_workspaceId_kind_idx" ON "instances"("workspaceId", "kind");
CREATE UNIQUE INDEX "instances_workspaceId_hostname_key" ON "instances"("workspaceId", "hostname");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

