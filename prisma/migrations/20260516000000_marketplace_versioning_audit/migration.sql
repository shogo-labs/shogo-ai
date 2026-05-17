-- Phase 4 + 6 + 7 schema bump.
--
-- Phase 6 (versioning + drift): adds `baselineManifest` JSON to
-- marketplace_installs so applyUpdate can detect on-disk drift before
-- overwriting user-modified files.
--
-- Phase 7 (audit + admin review): adds AuditStatus enum + audit columns to
-- marketplace_listing_versions, plus rejectionReason/reviewedAt/reviewedBy
-- on marketplace_listings, and extends ListingStatus with `pending_review`
-- + `rejected`. Existing `in_review` value is kept (legacy) so this is
-- additive; the new submission flow uses `pending_review`.
--
-- Note: `Project.templateId` is intentionally left intact in this
-- migration. Phase 1's data migration (migrate-templates-to-marketplace.ts)
-- backfills MarketplaceInstall rows from Project.templateId values, so the
-- column has to survive until that script has run on every environment.
-- A follow-up migration drops it.

-- ─── ListingStatus: add pending_review + rejected ─────────────────────────
ALTER TYPE "ListingStatus" ADD VALUE IF NOT EXISTS 'pending_review';
ALTER TYPE "ListingStatus" ADD VALUE IF NOT EXISTS 'rejected';

-- ─── AuditStatus enum ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "AuditStatus" AS ENUM ('none', 'pending', 'passed', 'flagged', 'errored');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ─── marketplace_installs.baselineManifest ────────────────────────────────
ALTER TABLE "marketplace_installs"
  ADD COLUMN IF NOT EXISTS "baselineManifest" JSONB;

-- ─── marketplace_listing_versions: audit fields ───────────────────────────
ALTER TABLE "marketplace_listing_versions"
  ADD COLUMN IF NOT EXISTS "auditStatus" "AuditStatus" NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "auditedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "auditedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "auditFindings" JSONB,
  ADD COLUMN IF NOT EXISTS "auditModel" TEXT;

-- ─── marketplace_listings: admin review queue fields ─────────────────────
ALTER TABLE "marketplace_listings"
  ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;
