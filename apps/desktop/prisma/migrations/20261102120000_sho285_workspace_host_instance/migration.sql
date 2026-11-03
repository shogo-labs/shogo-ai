-- SQLite mirror of prisma/migrations/20261102120000_sho285_workspace_host_instance
-- (SHO-285). The desktop never sets either column on its own workspaces; the
-- column exists so both schemas stay one model.
ALTER TABLE "workspaces" ADD COLUMN "hostInstanceId" TEXT;

CREATE INDEX "workspaces_hostInstanceId_idx" ON "workspaces"("hostInstanceId");

UPDATE "workspaces"
   SET "hostInstanceId" = "machineInstanceId",
       "machineInstanceId" = NULL
 WHERE "machineInstanceId" IS NOT NULL;

-- The cloud's change feed for hosted workspaces (unused on the desktop).
CREATE TABLE "host_sync_changes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspaceId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "host_sync_changes_workspaceId_id_idx" ON "host_sync_changes"("workspaceId", "id");

CREATE INDEX "host_sync_changes_createdAt_idx" ON "host_sync_changes"("createdAt");
