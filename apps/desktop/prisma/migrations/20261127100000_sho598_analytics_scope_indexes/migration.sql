-- Migration: sho598_analytics_scope_indexes
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma + apps/desktop/prisma/migrations/20261127100000_sho598_analytics_scope_indexes
--
-- SHO-598: the Analytics routes resolve "this workspace's chat sessions" to an
-- id list and then filter the tables behind them. These two indexes are what
-- make that filter an index scan instead of a heap fetch per candidate.
--
--   tool_call_logs — `WHERE "chatSessionId" IN (…) AND "createdAt" >= …
--                    AND "status" = …` (the workspace tool-call tile, the
--                    dashboard count, engagement). The old single-column
--                    "chatSessionId" index found the rows and then read 59k
--                    heap blocks to check the window and status; carrying both
--                    in the index made the count index-only (prod: 4.85 s cold
--                    → 0.39 s warm, and the visibility map is 91 % set).
--                    The single-column index is dropped: its leading column is
--                    this one's, so per-session reads and the cascade delete
--                    keep an index.
--   usage_events   — `WHERE "workspaceId" = … AND "actionType" IN (…) AND
--                    "createdAt" >= …` (the usage log, the dashboard's counts).
--                    With only ("workspaceId", "createdAt") the planner walked
--                    every action type in the window: 7.9 s for a workspace
--                    that is 34 % of the last 30 days.
--
-- Rollout (written down in the PR body, not automated here): `prisma migrate
-- deploy` runs at api pod boot and a plain `CREATE INDEX` takes a write lock, so
-- on production build BOTH indexes out of band first, on the primary, for US and
-- EU (`CREATE INDEX CONCURRENTLY` via `kubectl exec … psql`). `IF NOT EXISTS`
-- makes this migration a no-op where that has already happened, and still builds
-- them on a fresh install. Drop `tool_call_logs_chatSessionId_idx` concurrently
-- out of band only after the new index exists; the `DROP` below then no-ops.
--
-- Do not add further indexes here "while we're here" — every extra index is
-- write cost on the hottest inserts in the system.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tool_call_logs_chatSessionId_createdAt_status_idx" ON "tool_call_logs"("chatSessionId", "createdAt", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "usage_events_workspaceId_actionType_createdAt_idx" ON "usage_events"("workspaceId", "actionType", "createdAt");

-- DropIndex
DROP INDEX IF EXISTS "tool_call_logs_chatSessionId_idx";
