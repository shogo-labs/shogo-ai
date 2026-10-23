-- Migration: add_workspace_settings
-- Source:    prisma/schema.local.prisma (SQLite)

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "settings" TEXT;
