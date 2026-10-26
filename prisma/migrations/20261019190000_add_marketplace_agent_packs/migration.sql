-- Migration: add_marketplace_agent_packs
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same columns, JSON stored as TEXT)

-- AlterTable
ALTER TABLE "marketplace_listing_versions" ADD COLUMN     "systemPack" JSONB;

-- AlterTable
ALTER TABLE "marketplace_installs" ADD COLUMN     "answers" JSONB,
ADD COLUMN     "packBindings" JSONB;
