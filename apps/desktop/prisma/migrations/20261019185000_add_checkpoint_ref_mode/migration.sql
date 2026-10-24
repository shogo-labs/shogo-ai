-- Migration: add_checkpoint_ref_mode
-- Source:    prisma/schema.local.prisma
--
-- Snapshot commits can now live on a private ref (refs/shogo/checkpoints/**)
-- instead of the user's checked-out branch. Existing rows keep mode='branch'.

-- AlterTable
ALTER TABLE "project_checkpoints" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'branch';
ALTER TABLE "project_checkpoints" ADD COLUMN "refName" TEXT;
