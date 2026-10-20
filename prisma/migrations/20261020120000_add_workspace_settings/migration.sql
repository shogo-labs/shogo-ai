-- Migration: add_workspace_settings
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same column, JSON stored as TEXT)

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "settings" JSONB;
