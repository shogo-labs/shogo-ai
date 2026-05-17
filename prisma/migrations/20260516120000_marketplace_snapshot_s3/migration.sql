-- Migration: marketplace listing version snapshots move from
-- Postgres jsonb to S3.
--
-- We keep the legacy `workspaceSnapshot` jsonb column for one release
-- as a read-fallback. The boot-time backfiller materializes any
-- existing rows into S3, after which a follow-up migration drops the
-- column. New writes always populate the S3 columns; reads prefer
-- `workspaceSnapshotKey` and only fall back to `workspaceSnapshot`
-- when the key is null.

ALTER TABLE "marketplace_listing_versions"
  ADD COLUMN "workspaceSnapshotKey"      TEXT,
  ADD COLUMN "workspaceSnapshotBytes"    INTEGER,
  ADD COLUMN "workspaceSnapshotChecksum" TEXT;
