-- Migration: user-facing model picker metadata.
--
-- Adds optional per-model display metadata surfaced by the redesigned model
-- picker (see prisma/schema.prisma `ModelDefinition`):
--   - description: short blurb shown in the picker info panel
--   - contextWindow: total context window in tokens (distinct from maxOutputTokens)
--   - reasoningEffort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
--     (functional — drives the agent loop's thinkingLevel)

-- AlterTable
ALTER TABLE "model_definitions" ADD COLUMN "description" TEXT;
ALTER TABLE "model_definitions" ADD COLUMN "contextWindow" INTEGER;
ALTER TABLE "model_definitions" ADD COLUMN "reasoningEffort" TEXT;
