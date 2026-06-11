-- Per-creator content-CPM override (cents per 1,000 NEW views). Mirrors
-- affiliates.commissionRateBps: NULL = use the platform affiliate.content.*
-- PlatformSetting; when set, overrides the platform/per-platform CPM for this
-- affiliate's content earnings.
ALTER TABLE "affiliates" ADD COLUMN "contentCpmCents" INTEGER;
