-- Migration: add_workspace_agent_reply_concurrency
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same column, SQLite)
--
-- How many agent replies may be working at once in a workspace. Null means
-- "the maximum the plan allows" (24 in local mode).

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "agentReplyConcurrency" INTEGER;
