-- A machine's identity is its device id, not its hostname (SHO-276).
-- macOS renames itself per network (`Russells-MacBook-Pro-2.local` →
-- `unknown2e36ea9404bb.attlocal.net`), which forked one machine into two
-- `instances` rows and froze the cloud copy of its workspaces.
ALTER TABLE "instances" ADD COLUMN "deviceId" TEXT;

CREATE INDEX "instances_workspaceId_userId_deviceId_idx"
  ON "instances"("workspaceId", "userId", "deviceId");
