-- AlterTable: add device-session metadata to api_keys.
-- "kind" distinguishes manually-created keys ("user") from keys minted via
-- the desktop cloud-login flow ("device"). Device keys carry a stable
-- deviceId so the same machine dedupes instead of accumulating stale keys.
ALTER TABLE "api_keys" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "api_keys" ADD COLUMN "deviceId" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "deviceName" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "devicePlatform" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "deviceAppVersion" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

-- Index to support dedupe lookups by (workspaceId, deviceId) when minting
-- a device key for an already-seen machine.
CREATE INDEX "api_keys_workspaceId_deviceId_idx" ON "api_keys"("workspaceId", "deviceId");
