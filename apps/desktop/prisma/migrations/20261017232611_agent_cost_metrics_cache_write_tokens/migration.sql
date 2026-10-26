-- Migration: agent_cost_metrics_cache_write_tokens
-- Source:    prisma/schema.local.prisma
--
-- Hand-trimmed from `bun run db:migrate:desktop --name agent_cost_metrics_cache_write_tokens`:
-- SQLite can add a defaulted column in place, so the generated table rebuild
-- (and the unrelated signup_attributions index redefine it carried) is not needed.

-- AlterTable
ALTER TABLE "agent_cost_metrics" ADD COLUMN "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0;
