-- Migration: social_usage_meters
-- Source:    prisma/schema.prisma
--
-- SHO-71 P6: the two meters that bill per row, not per call.
--
-- `social_account_monthly` charges each connected account once per calendar
-- month, prorated by the days it was active, so the account row needs a
-- watermark of the month it has been charged for. Without it a daily sweep
-- would re-charge the same account every tick.
--
-- `social_x_api` charges $0.015 per published post on X ($0.20 when the post
-- carries a link), so the per-account leg needs its own marker: a dispatch that
-- is retried after a partial failure must not bill a post that already went out.

-- AlterTable
ALTER TABLE "social_accounts" ADD COLUMN "monthlyRateDebitedFor" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "social_post_targets" ADD COLUMN "meteredAt" TIMESTAMP(3);
