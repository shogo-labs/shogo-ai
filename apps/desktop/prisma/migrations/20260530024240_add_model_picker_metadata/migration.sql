-- Migration: add_model_picker_metadata
-- Generated: 2026-05-30 by scripts/db-migrate-desktop.ts (trimmed to scope)
-- Source:    prisma/schema.local.prisma
--
-- Only the new model-picker metadata columns are included. The full
-- `prisma migrate diff` also surfaced redefinitions of several pre-existing
-- ACCEPTED_DRIFT tables (agent_configs, projects, usage_wallets, etc. — see
-- scripts/check-desktop-schema-drift.ts). Those are tracked tech debt and
-- intentionally left out so this migration stays scoped to the model-catalog
-- change.

-- AlterTable
ALTER TABLE "model_definitions" ADD COLUMN "contextWindow" INTEGER;
ALTER TABLE "model_definitions" ADD COLUMN "description" TEXT;
ALTER TABLE "model_definitions" ADD COLUMN "reasoningEffort" TEXT;
