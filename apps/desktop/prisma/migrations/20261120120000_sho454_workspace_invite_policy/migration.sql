-- Migration: SHO-454 Workspace.invitePolicy
-- Source:    prisma/schema.local.prisma
--
-- Who may invite people to a workspace. NULL means "members": any Editor can
-- invite as Editor or Viewer. "admins" restricts inviting to owners and
-- admins. Viewers can never invite either way.
--
-- Additive and nullable. NULL reads as "members", so every existing workspace
-- starts on the Slack/Linear default (any Editor can invite); an admin who
-- wants the old owners-and-admins-only rule sets "admins".

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "invitePolicy" TEXT;
