-- Migration: device_version_events_region_ids
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same columns; see the SQLite twin)
--
-- Fixes the 2026-10-22 replication outage (SHO-142).
--
-- What went wrong
-- ---------------
-- `20261021120000_add_device_version_events` backfilled ids as
-- `'dve_' || md5("deviceId" || ':' || "deviceAppVersion")`. Both regions run
-- migrations on their own primary against an `api_keys` that has *already*
-- been replicated, so US and EU computed the *same* primary keys for the same
-- rows (228 vs 226 rows). The table was in `shogo_all_pub`, so EU's tablesync
-- `COPY` died on its first row with a duplicate-key violation on
-- `device_version_events_pkey`, which disabled `sub_from_us`. US -> EU
-- replication was down 04:40Z-05:05Z and the backlog reached 540 MB, because
-- `conflict-watchdog` cannot skip a tablesync duplicate.
--
-- Two things change here
-- ----------------------
-- 1. **IDs are random, never derived from row content.** A key computed from
--    replicated data is the same key in every region by construction. Every
--    row written from now on relies on the model's `@default(cuid())`;
--    nothing in the codebase ever passes `id`. See RUNBOOK
--    «Multi-region migration rules».
--
-- 2. **The unique key is region-scoped**: `(region, deviceId, version)`.
--    A random id alone would still poison-pill: two regions that both see one
--    device+version (failover, or the `resolveApiKey` opportunistic touch)
--    would mint two ids for one logical row, and the peer's apply on the old
--    `(deviceId, version)` unique index would abort the worker. `region` is
--    part of the key so two regions can never collide on it; a peer's row is
--    just a second tag for the same (device, version), and the analytics
--    reader collapses the tags through a `Set`.
--
-- Why `region` stays NULL on the pre-migration rows
-- -------------------------------------------------
-- Those 456 rows were written when nobody recorded a region, so there is no
-- honest value to backfill. They MUST stay NULL: NULLs are distinct in a
-- Postgres unique index, so the two regions' legacy rows can never collide
-- during the next tablesync. A `NOT NULL DEFAULT 'legacy'` backfill would
-- hand both regions the same `('legacy', deviceId, version)` key and re-run
-- this incident on the next publish. The application always writes a region
-- (see `lib/device-version-events.ts`), so NULL only ever means "written
-- before region tagging".
--
-- Consequence we accept: a device that already has a legacy row gets a
-- second, region-tagged row on its next heartbeat (~456 extra rows in total).
-- The reader collapses them and the legacy row keeps the historical
-- `firstSeenAt`, so they are deliberately NOT merged here.
--
-- Idempotent: only md5-derived ids match `^dve_[0-9a-f]{32}$`. The
-- replacement carries the uuid's dashes, so a replay matches nothing and is
-- a no-op. `ADD COLUMN IF NOT EXISTS` keeps the whole file re-runnable as well
-- (SQLite has no equivalent, so the desktop twin is single-application only —
-- Prisma's `_prisma_migrations` ledger guarantees that).

ALTER TABLE "device_version_events" ADD COLUMN IF NOT EXISTS "region" TEXT;

-- Rewrite the derived ids. Random, so the two regions stop agreeing on a key.
UPDATE "device_version_events"
   SET "id" = 'dve_' || gen_random_uuid()::text
 WHERE "id" ~ '^dve_[0-9a-f]{32}$';

-- Region-scoped key. Two regions may hold a tag for the same (device,
-- version); neither may hold two tags for its own.
DROP INDEX IF EXISTS "device_version_events_deviceId_version_key";
CREATE UNIQUE INDEX IF NOT EXISTS "device_version_events_region_deviceId_version_key"
  ON "device_version_events" ("region", "deviceId", "version");
