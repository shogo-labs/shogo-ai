-- Migration: add_device_version_events
-- Source:    prisma/schema.local.prisma (SQLite)
-- Mirrors prisma/migrations/20261021120000_add_device_version_events/migration.sql.
--
-- Per-(device, version) install history so version adoption survives the row
-- churn on `api_keys` (which keeps one live row per workspace+device).

-- CreateTable
CREATE TABLE "device_version_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "os" TEXT NOT NULL DEFAULT 'unknown',
    "arch" TEXT,
    "client" TEXT NOT NULL DEFAULT 'desktop',
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "version" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "device_version_events_deviceId_version_key" ON "device_version_events"("deviceId", "version");

-- CreateIndex
CREATE INDEX "device_version_events_lastSeenAt_idx" ON "device_version_events"("lastSeenAt");

-- CreateIndex
CREATE INDEX "device_version_events_version_idx" ON "device_version_events"("version");

-- Backfill: one row per (live device, version) already visible in api_keys.
-- firstSeenAt is the last sighting (see the Postgres twin): a key's createdAt
-- does not say when the device adopted the version a heartbeat wrote onto it.
-- SQLite has no REGEXP by default, so the beta channel is detected with
-- instr() — the runtime normaliser in lib/device-platform.ts stays
-- authoritative for anything written after this migration.
INSERT INTO "device_version_events" (
    "id", "deviceId", "os", "arch", "client", "channel", "version", "firstSeenAt", "lastSeenAt"
)
SELECT
    'dve_' || lower(hex(randomblob(10))),
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
    CASE WHEN instr(lower(k."deviceAppVersion"), 'beta') > 0 THEN 'beta' ELSE 'stable' END,
    k."deviceAppVersion",
    COALESCE(max(k."lastSeenAt"), max(k."createdAt"), CURRENT_TIMESTAMP),
    COALESCE(max(k."lastSeenAt"), max(k."createdAt"), CURRENT_TIMESTAMP)
FROM "api_keys" k
WHERE k."kind" = 'device'
  AND k."revokedAt" IS NULL
  AND k."deviceId" IS NOT NULL
  AND k."deviceAppVersion" IS NOT NULL
  AND k."deviceAppVersion" <> ''
GROUP BY k."deviceId", k."deviceAppVersion";
