-- SQLite mirror of prisma/migrations/20260516000000_marketplace_versioning_audit
--
-- See the PG migration for the narrative. Notes specific to SQLite:
--
--   * `ListingStatus` and `AuditStatus` are enums in the cloud schema; in
--     SQLite they're TEXT columns with no compile-time check (the existing
--     `marketplace_listings.status` column is already TEXT, so the new
--     'pending_review' / 'rejected' values just become valid strings).
--   * `auditFindings` is JSONB on PG; here it's TEXT and the application
--     `JSON_OBJECT_FIELDS` allowlist in apps/api/src/lib/prisma.ts handles
--     the encode/decode round-trip.
--   * `baselineManifest` is JSONB on PG; here it's TEXT (same JSON-string
--     encoding as `workspaceSnapshot`).

PRAGMA foreign_keys = OFF;

-- ─── marketplace_installs.baselineManifest ────────────────────────────────
ALTER TABLE "marketplace_installs" ADD COLUMN "baselineManifest" TEXT;

-- ─── marketplace_listing_versions: audit fields ───────────────────────────
ALTER TABLE "marketplace_listing_versions" ADD COLUMN "auditStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "marketplace_listing_versions" ADD COLUMN "auditedAt" DATETIME;
ALTER TABLE "marketplace_listing_versions" ADD COLUMN "auditedBy" TEXT;
ALTER TABLE "marketplace_listing_versions" ADD COLUMN "auditFindings" TEXT;
ALTER TABLE "marketplace_listing_versions" ADD COLUMN "auditModel" TEXT;

-- ─── marketplace_listings: admin review queue fields ─────────────────────
ALTER TABLE "marketplace_listings" ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "marketplace_listings" ADD COLUMN "reviewedAt" DATETIME;
ALTER TABLE "marketplace_listings" ADD COLUMN "reviewedBy" TEXT;

PRAGMA foreign_keys = ON;
