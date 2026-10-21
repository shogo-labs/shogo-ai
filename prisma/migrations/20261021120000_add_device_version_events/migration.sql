-- Migration: add_device_version_events
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same columns)
--
-- `api_keys` only keeps one live row per (workspace, device), so install
-- analytics could never answer "how many devices were on 2.3.5 the day 2.3.6
-- shipped" and the admin card could only show the number that happens to be
-- current. This is the per-(device, version) history behind adoption.
--
-- os / arch / client / channel are normalised once at the insert point
-- (apps/api/src/lib/device-platform.ts): production carried 8 platform
-- spellings for 3 operating systems and 11 `shogo-cli/*` rows inside the
-- Desktop segment.

-- CreateTable
CREATE TABLE "device_version_events" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "os" TEXT NOT NULL DEFAULT 'unknown',
    "arch" TEXT,
    "client" TEXT NOT NULL DEFAULT 'desktop',
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "version" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_version_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_version_events_deviceId_version_key" ON "device_version_events"("deviceId", "version");

-- CreateIndex
CREATE INDEX "device_version_events_lastSeenAt_idx" ON "device_version_events"("lastSeenAt");

-- CreateIndex
CREATE INDEX "device_version_events_version_idx" ON "device_version_events"("version");

-- Backfill: one row per (live device, version) already visible in api_keys.
-- Keys are re-minted and revoked on re-login, so grouping by
-- (deviceId, version) keeps the real history while still honouring the
-- unique index. Grouping also collapses the per-workspace duplicate rows one
-- physical device holds (34 such devices in production).
--
-- firstSeenAt is the last sighting, not the key's creation: a long-lived key
-- has its deviceAppVersion rewritten in place by a heartbeat (see
-- POST /api-keys/heartbeat), so `createdAt` says nothing about when the device
-- adopted the version it is on now. Using it would make the adoption series
-- claim the current version for the whole window before it even shipped.
INSERT INTO "device_version_events" (
    "id", "deviceId", "os", "arch", "client", "channel", "version", "firstSeenAt", "lastSeenAt"
)
SELECT
    'dve_' || md5(k."deviceId" || ':' || k."deviceAppVersion"),
    k."deviceId",
    CASE
        WHEN lower(max(k."devicePlatform")) LIKE 'darwin%' THEN 'macos'
        WHEN lower(max(k."devicePlatform")) LIKE 'macos%' THEN 'macos'
        WHEN lower(max(k."devicePlatform")) LIKE 'win32%' THEN 'windows'
        WHEN lower(max(k."devicePlatform")) LIKE 'windows%' THEN 'windows'
        WHEN lower(max(k."devicePlatform")) LIKE 'linux%' THEN 'linux'
        ELSE 'unknown'
    END,
    CASE
        WHEN lower(max(k."devicePlatform")) LIKE '%arm64%' THEN 'arm64'
        WHEN lower(max(k."devicePlatform")) LIKE '%aarch64%' THEN 'arm64'
        WHEN lower(max(k."devicePlatform")) LIKE '%-x64%' THEN 'x64'
        WHEN lower(max(k."devicePlatform")) LIKE '%amd64%' THEN 'x64'
        ELSE NULL
    END,
    CASE WHEN lower(k."deviceAppVersion") LIKE 'shogo-cli/%' THEN 'cli' ELSE 'desktop' END,
    CASE
        WHEN k."deviceAppVersion" ~* '(^|[.-])beta([.-]|$)' THEN 'beta'
        ELSE 'stable'
    END,
    k."deviceAppVersion",
    COALESCE(max(k."lastSeenAt"), max(k."createdAt"), CURRENT_TIMESTAMP),
    COALESCE(max(k."lastSeenAt"), max(k."createdAt"), CURRENT_TIMESTAMP)
FROM "api_keys" k
WHERE k."kind" = 'device'
  AND k."revokedAt" IS NULL
  AND k."deviceId" IS NOT NULL
  AND k."deviceAppVersion" IS NOT NULL
  AND k."deviceAppVersion" <> ''
GROUP BY k."deviceId", k."deviceAppVersion"
ON CONFLICT ("deviceId", "version") DO NOTHING;
