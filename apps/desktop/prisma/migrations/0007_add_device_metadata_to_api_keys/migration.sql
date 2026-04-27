-- AlterTable: add device-session metadata to api_keys. See
-- prisma/migrations/20260420120000_add_device_metadata_to_api_keys for the
-- matching Postgres migration. SQLite ALTER TABLE ... ADD COLUMN only supports
-- one column per statement.
ALTER TABLE "api_keys" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "api_keys" ADD COLUMN "deviceId" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "deviceName" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "devicePlatform" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "deviceAppVersion" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "lastSeenAt" DATETIME;

CREATE INDEX "api_keys_workspaceId_deviceId_idx" ON "api_keys"("workspaceId", "deviceId");
