-- Migration: workspace_move_context
-- Desktop:   apps/desktop/prisma/migrations/20261029070000_workspace_move_context
--
-- The move job outlives the request that started it: it is paused, resumed from
-- the UI, and restarted by the crash sweep. Until now the requester identity
-- travelled only in the `kickMove` context, so a resume fell back to
-- `requesterId: ''` / `isOwner: true` and rebuilt a *different* row set than the
-- plan the user approved (a DM the requester cannot see was excluded by the plan
-- and included by the resume), and `ownerUserId` fell to `''`, which could
-- create an ownerless target workspace.
--
-- Persist them on the row so a resumed job is the same job.
--
-- All three are nullable: rows created before this migration carry no
-- identity, and the job falls back to the previous defaults for those.

-- AlterTable
ALTER TABLE "workspace_moves" ADD COLUMN "requesterId" TEXT,
ADD COLUMN "isOwner" BOOLEAN,
ADD COLUMN "ownerUserId" TEXT;
