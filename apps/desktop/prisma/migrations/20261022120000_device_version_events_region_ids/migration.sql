-- Migration: device_version_events_region_ids
-- Source:    prisma/schema.local.prisma (SQLite)
-- Mirrors prisma/migrations/20261022120000_device_version_events_region_ids/migration.sql.
--
-- Desktop ids were never derived from row content: the twin migration
-- backfills `'dve_' || lower(hex(randomblob(10)))`, so there is nothing to
-- rewrite here and no data to touch. This migration exists for schema parity
-- (`check:schema-parity`, `check:migrations`) and to keep the two tracks
-- field-identical.
--
-- The unique key still becomes `(region, deviceId, version)`: `region` is
-- part of the key on both tracks so a row written here and the same device's
-- row written in the cloud cannot be confused, and it keeps the model shape
-- identical to the Postgres one. Pre-migration rows keep `region = NULL`,
-- which SQLite also treats as distinct per row in a unique index. The
-- application always writes a region (see lib/device-version-events.ts).

ALTER TABLE "device_version_events" ADD COLUMN "region" TEXT;

DROP INDEX IF EXISTS "device_version_events_deviceId_version_key";
CREATE UNIQUE INDEX IF NOT EXISTS "device_version_events_region_deviceId_version_key"
  ON "device_version_events" ("region", "deviceId", "version");
