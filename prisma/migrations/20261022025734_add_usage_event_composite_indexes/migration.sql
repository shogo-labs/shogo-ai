-- Migration: add_usage_event_composite_indexes
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma + apps/desktop/prisma/migrations/20261022025734_add_usage_event_composite_indexes
--
-- Every Analytics read is "one workspace (or project) over a date window".
-- With only the single-column indexes Postgres bitmap-ANDs
-- `usage_events_workspaceId_idx` and `usage_events_createdAt_idx`, heap-fetches
-- the whole workspace and then disk-sorts it (`external merge  Disk: 14192 kB`
-- on a 148k-event window, SHO-140). The composite index answers the range and
-- returns the rows already ordered.
--
-- Rollout (written down in the PR body, not automated here): `prisma migrate
-- deploy` runs at api pod boot and a plain `CREATE INDEX` takes a write lock,
-- so on a 2.1M-row production table create both indexes out of band first
-- (`CREATE INDEX CONCURRENTLY` via `kubectl exec … psql`). `IF NOT EXISTS`
-- makes this migration a no-op where that has already happened, and still
-- builds them on a fresh install.
--
-- Do not add a third index here "while we're here" — every extra index is
-- write cost on the hottest insert in the system.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "usage_events_workspaceId_createdAt_idx" ON "usage_events"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "usage_events_projectId_createdAt_idx" ON "usage_events"("projectId", "createdAt");
