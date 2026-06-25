-- Add per-user write-ownership region.
--
-- Identity-scoped rows (the user row itself, notifications, etc.) are routed to
-- this region so a given user is only ever written in one place, keeping
-- active-active logical replication conflict-free for identity data. Nullable:
-- existing rows are backfilled by a separate data migration, and the router
-- treats NULL as the primary region.
--
-- Written idempotently (IF NOT EXISTS): the cloud runs migrations per-region and
-- the column may be pre-applied out-of-band to keep replication parity, so a
-- plain ADD COLUMN would fail "already exists" and record a failed migration
-- (P3009) that blocks the region.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "homeRegion" TEXT;

CREATE INDEX IF NOT EXISTS "users_homeRegion_idx" ON "users"("homeRegion");
