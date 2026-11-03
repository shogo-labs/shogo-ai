-- A paired desktop's workspace is a normal workspace hosted on that desktop
-- (SHO-285, the metal model). `hostInstanceId` names the host; the read-only
-- `machineInstanceId` copy marker is retired. Existing copies become hosted
-- workspaces in place: same id, same rows, now writable from the cloud.
ALTER TABLE "workspaces" ADD COLUMN "hostInstanceId" TEXT;

CREATE INDEX "workspaces_hostInstanceId_idx" ON "workspaces"("hostInstanceId");

UPDATE "workspaces"
   SET "hostInstanceId" = "machineInstanceId",
       "machineInstanceId" = NULL
 WHERE "machineInstanceId" IS NOT NULL;

-- The cloud's change feed for hosted workspaces: the desktop pulls it by cursor.
CREATE TABLE "host_sync_changes" (
    "id" SERIAL NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "host_sync_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "host_sync_changes_workspaceId_id_idx" ON "host_sync_changes"("workspaceId", "id");

CREATE INDEX "host_sync_changes_createdAt_idx" ON "host_sync_changes"("createdAt");
