-- Migration: add_marketplace_agent_packs
-- Source:    prisma/schema.local.prisma (SQLite)

-- AlterTable
ALTER TABLE "marketplace_listing_versions" ADD COLUMN "systemPack" TEXT;

-- AlterTable
ALTER TABLE "marketplace_installs" ADD COLUMN "answers" TEXT;
ALTER TABLE "marketplace_installs" ADD COLUMN "packBindings" TEXT;
