-- Migration: Workspace.invitePolicy (SHO-454).
--
-- Who may invite people to a workspace. NULL means "members": any Editor can
-- invite as Editor or Viewer, the Slack/Linear default. "admins" restricts
-- inviting to owners and admins. Viewers can never invite either way.
--
-- Additive and nullable. NULL reads as "members", so every existing workspace
-- starts on the Slack/Linear default (any Editor can invite) the moment this
-- ships; an admin who wants the old owners-and-admins-only rule sets "admins".
-- DDL only: `workspaces` is a published table, so a backfill UPDATE here would
-- write the same logical rows in every region (RUNBOOK §3).

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "invitePolicy" TEXT;
