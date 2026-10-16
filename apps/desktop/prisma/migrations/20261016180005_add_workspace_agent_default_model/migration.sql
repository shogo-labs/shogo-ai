-- Migration: add_workspace_agent_default_model
-- Source:    prisma/schema.local.prisma
--
-- Equivalent to the output of
--   prisma migrate diff --from-migrations apps/desktop/prisma/migrations --to-schema prisma/schema.local.prisma --script

-- AlterTable
ALTER TABLE "workspace_agent_profiles" ADD COLUMN "defaultModel" TEXT;
