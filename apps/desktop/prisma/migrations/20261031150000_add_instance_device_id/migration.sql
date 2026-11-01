-- SQLite mirror of prisma/migrations/20261031150000_add_instance_device_id
-- (SHO-276). The desktop `instances` table exists from 0002_add_missing_models
-- even though apps/desktop/prisma/schema.prisma no longer models it.
ALTER TABLE "instances" ADD COLUMN "deviceId" TEXT;

CREATE INDEX "instances_workspaceId_userId_deviceId_idx"
  ON "instances"("workspaceId", "userId", "deviceId");
