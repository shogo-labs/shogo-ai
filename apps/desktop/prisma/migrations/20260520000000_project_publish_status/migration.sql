-- Local (SQLite) mirror of the cloud Project publish-status columns.
-- See prisma/migrations/20260520000000_project_publish_status for the
-- PG-side enum form and the rationale (b11c65dd-... 2026-05-20 incident:
-- a frozen runtime publish left zero observable trail in the DB).
--
-- SQLite has no native enum, so we use TEXT + CHECK pinning the
-- allowed values to the same set as the PG enum.
--
-- Additive + defaulted -> zero downtime. Desktop publishing is a
-- no-op in local mode today, so this column is mostly here for
-- schema parity (a single Project row needs to roundtrip
-- desktop <-> cloud).

PRAGMA foreign_keys = OFF;

ALTER TABLE "projects"
  ADD COLUMN "publishStatus" TEXT NOT NULL DEFAULT 'idle'
  CHECK ("publishStatus" IN ('idle', 'building', 'uploading', 'configuring', 'live', 'failed'));

ALTER TABLE "projects"
  ADD COLUMN "publishError" TEXT;

ALTER TABLE "projects"
  ADD COLUMN "publishStatusAt" DATETIME;

PRAGMA foreign_keys = ON;
