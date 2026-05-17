-- SQLite mirror of prisma/migrations/20260516120000_marketplace_snapshot_s3
--
-- Workspace snapshots move from inline JSON storage to S3. The legacy
-- `workspaceSnapshot` TEXT column stays as a read-fallback for one
-- release; new writes populate the S3 columns and leave the legacy
-- column null. See the matching PG migration for the full narrative.
--
-- Local SQLite installs that never publish to a remote marketplace can
-- ignore the S3 columns entirely — the columns are nullable and the
-- application reads `workspaceSnapshotKey` first, falling back to
-- `workspaceSnapshot` when the key is null.

PRAGMA foreign_keys = OFF;

ALTER TABLE "marketplace_listing_versions" ADD COLUMN "workspaceSnapshotKey" TEXT;
ALTER TABLE "marketplace_listing_versions" ADD COLUMN "workspaceSnapshotBytes" INTEGER;
ALTER TABLE "marketplace_listing_versions" ADD COLUMN "workspaceSnapshotChecksum" TEXT;

PRAGMA foreign_keys = ON;
