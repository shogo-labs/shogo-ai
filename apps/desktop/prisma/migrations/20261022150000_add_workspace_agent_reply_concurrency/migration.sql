-- Migration: add_workspace_agent_reply_concurrency
-- Source:    prisma/schema.local.prisma (SQLite)
--
-- Cloud twin: prisma/migrations/20261022150000_add_workspace_agent_reply_concurrency

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "agentReplyConcurrency" INTEGER;
