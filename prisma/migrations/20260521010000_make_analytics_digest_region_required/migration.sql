-- Tighten `analytics_digests.region` to NOT NULL now that the rollout
-- migration (20260521000000_add_region_to_analytics_digest) has been
-- applied in every region and the manual backfill from the 2026-05-21
-- recovery has tagged every existing row with its origin region
-- (`us-ashburn-1`, `eu-frankfurt-1`, `ap-mumbai-1`). The collector at
-- apps/api/src/lib/analytics-digest-collector.ts defaults missing
-- REGION_ID env to the sentinel `'unknown'` so local/dev/test runs
-- still satisfy the constraint without sneaking past it with a NULL.
--
-- PRE-FLIGHT before applying in each region:
--   SELECT count(*) FROM analytics_digests WHERE region IS NULL;
-- must return 0. Failing that, backfill first
--   (UPDATE analytics_digests SET region = '<region-id>' WHERE region IS NULL;)
-- because ALTER COLUMN SET NOT NULL will refuse on any NULL row.

ALTER TABLE "analytics_digests" ALTER COLUMN "region" SET NOT NULL;
