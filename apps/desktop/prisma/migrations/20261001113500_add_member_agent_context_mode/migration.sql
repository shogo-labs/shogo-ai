-- Migration: add_member_agent_context_mode

-- AlterTable
ALTER TABLE "conversation_members" ADD COLUMN "agentContextMode" TEXT NOT NULL DEFAULT 'shared';
