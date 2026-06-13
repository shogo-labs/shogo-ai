-- Per-creator per-video lifetime earnings cap (cents). NULL = fall back to the
-- platform `affiliate.content.perVideoCapCents` PlatformSetting (which itself
-- defaults to no cap). When set, a single connected video stops accruing
-- content-CPM commissions once its cumulative `source='content'` earnings reach
-- this amount — the per-creator analogue of the "cap $X per video" campaign rule.
ALTER TABLE "affiliates" ADD COLUMN "contentPerVideoCapCents" INTEGER;

-- Cumulative content-CPM commission cents already accrued on a post (the dollar
-- high-water mark, analogous to `paidViews`). Enforces the per-video cap above:
-- once `paidCents` reaches the resolved cap, the post stops accruing.
ALTER TABLE "affiliate_posts" ADD COLUMN "paidCents" INTEGER NOT NULL DEFAULT 0;
