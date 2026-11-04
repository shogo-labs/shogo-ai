-- Migration: sho311_analytics_indexes
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma + apps/desktop/prisma/migrations/20261104120000_sho311_analytics_indexes
--
-- SHO-311: the analytics pages pull date windows that had no index to read
-- them with.
--
--   tool_call_logs  — tool-call analytics is `WHERE "createdAt" >= … AND
--                     "createdAt" < …` over the whole table (2M rows in prod).
--                     The only date-ordered index was ("userId", "createdAt"),
--                     useless when no userId is bound, so every admin page
--                     scanned and sorted the table.
--   usage_events    — the member-scoped reads ("/me/analytics/usage-summary",
--                     the per-member workspace tab) filter "memberId" over a
--                     window. ("memberId") and ("createdAt") separately leave
--                     the planner bitmap-ANDing + sorting; one member's usage
--                     log measured 44 s.
--   chat_messages   — the activity and quality trends count messages per day
--                     with no session filter, which none of the session-leading
--                     indexes can serve.
--
-- Rollout (written down in the PR body, not automated here): `prisma migrate
-- deploy` runs at api pod boot and a plain `CREATE INDEX` takes a write lock, so
-- on production build the three indexes out of band first
-- (`CREATE INDEX CONCURRENTLY` via `kubectl exec … psql`). `IF NOT EXISTS`
-- makes this migration a no-op where that has already happened, and still
-- builds them on a fresh install.
--
-- Do not add further indexes here "while we're here" — every extra index is
-- write cost on the hottest inserts in the system.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tool_call_logs_createdAt_idx" ON "tool_call_logs"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "usage_events_memberId_createdAt_idx" ON "usage_events"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_messages_createdAt_idx" ON "chat_messages"("createdAt");
