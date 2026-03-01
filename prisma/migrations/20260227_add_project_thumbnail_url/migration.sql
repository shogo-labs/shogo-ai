-- AlterTable (IF NOT EXISTS: this column is also added by
-- 20260227_add_agent_configs_invite_links_project_type; this migration
-- is kept for history but must be idempotent to avoid duplicate-column errors)
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "thumbnailUrl" TEXT;
