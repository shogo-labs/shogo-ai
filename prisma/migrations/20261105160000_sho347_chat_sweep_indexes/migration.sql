-- Migration: sho347_chat_sweep_indexes
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma + apps/desktop/prisma/migrations/20261105160000_sho347_chat_sweep_indexes
--
-- SHO-347 (PERF-20): two team-chat background loops poll `conversation_messages`
-- on every API pod and no index fitted either query. Their DB time went from
-- ~1.0k s/day (Nov 2) to ~5.6k s/day (Nov 5) while call volume stayed flat —
-- each call just scanned more rows.
--
--   conversation_messages_running_agent_idx
--     The dead-reply sweep (`sweepDeadAgentReplies`) polls for
--     authorType='agent' AND agentStatus='running' AND deletedAt IS NULL, plus
--     threadRootId IS NOT NULL. There was no index on agentStatus/authorType at
--     all, so every pod seq-scanned the whole table to find the handful of rows
--     that are running right now. Partial: the index holds only those rows, so
--     it stays a few pages and costs almost nothing on insert.
--
--   conversation_messages_createdAt_idx
--     The search indexer anti-joins `conversation_message_embeddings` over a
--     createdAt window, ORDER BY createdAt DESC. The only date-ordered indexes
--     lead with conversationId/workspaceId, so this range scan had nothing to
--     read. `createdAt` never changes, so HOT updates from streaming agent
--     replies still work on the table.
--
-- Rollout (written down in the PR body, not automated here): `prisma migrate
-- deploy` runs at api pod boot and a plain `CREATE INDEX` takes a write lock, so
-- on production build both indexes out of band first (`CREATE INDEX
-- CONCURRENTLY` via `kubectl exec … psql`). `IF NOT EXISTS` makes this migration
-- a no-op where that has already happened, and still builds them on a fresh
-- install.
--
-- Do not add further indexes here "while we're here" — every extra index is
-- write cost on the hottest inserts in the system.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "conversation_messages_createdAt_idx" ON "conversation_messages"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "conversation_messages_running_agent_idx" ON "conversation_messages"("threadRootId") WHERE "agentStatus" = 'running' AND "authorType" = 'agent' AND "deletedAt" IS NULL;
