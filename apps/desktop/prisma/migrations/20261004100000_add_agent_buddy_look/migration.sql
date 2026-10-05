-- Migration: add_agent_buddy_look
-- Hand-written to match prisma/schema.local.prisma; the only intended change is
-- projects.buddyLook and workspace_agent_profiles.buddyLook (JSON-encoded Shogo
-- buddy look for a team-chat agent).

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "buddyLook" TEXT;

-- AlterTable
ALTER TABLE "workspace_agent_profiles" ADD COLUMN "buddyLook" TEXT;
