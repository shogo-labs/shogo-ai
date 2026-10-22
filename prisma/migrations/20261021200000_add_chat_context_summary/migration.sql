-- Migration: add_chat_context_summary
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same columns, TEXT instead of @db.Text)
--
-- A chat's durable summary, kept in the API database instead of the runtime's
-- pod-local `sessions.db`, so it survives an evicted session, a pod restart or
-- a machine that was asleep. `contextSummaryThroughCount` is the message-count
-- watermark: the first that many chat messages are covered by the summary and
-- every later turn carries it, so a prompt never degrades to a one-line wake
-- note (SHO-137).

-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN     "contextSummary" TEXT,
ADD COLUMN     "contextSummaryThroughCount" INTEGER NOT NULL DEFAULT 0;
