-- Migration: sho551_publish_notice
-- Desktop (SQLite) twin of prisma/migrations/20261124193000_sho551_publish_notice.
--
-- Same column, SQLite spells it TEXT. A Postgres seed can skip rows whose FK
-- target was deleted and reports them; a publish answers 202 and finishes in
-- the background (SHO-542), so the report has nowhere to live except the
-- environment row. Nullable, no backfill: no notice means no skipped rows.

-- AlterTable
ALTER TABLE "published_environments" ADD COLUMN "publishNotice" TEXT;
