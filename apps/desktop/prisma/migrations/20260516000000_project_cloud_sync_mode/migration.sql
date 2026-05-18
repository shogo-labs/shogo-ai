-- Local (SQLite) mirror of the cloud `Project.cloudSyncMode` column.
-- See prisma/migrations/20260516000000_project_cloud_sync_mode for the
-- PG-side enum form. SQLite has no native enum type, so we store the
-- mode as TEXT with a CHECK constraint pinning the allowed values to
-- the same set as the PG enum ('s3' | 'dual_shadow' | 'git_only').
--
-- Additive + defaulted -> zero downtime, no behavioral change for
-- rows that don't opt in. The desktop runtime ignores any value other
-- than 's3' today (workspace mode never speaks to the cloud git
-- smart-HTTP backend), but the column is here so schema parity holds
-- and so a single Project row can roundtrip between desktop ↔ cloud.

PRAGMA foreign_keys = OFF;

ALTER TABLE "projects"
  ADD COLUMN "cloudSyncMode" TEXT NOT NULL DEFAULT 's3'
  CHECK ("cloudSyncMode" IN ('s3', 'dual_shadow', 'git_only'));

PRAGMA foreign_keys = ON;
