-- Migration: add_checkpoint_ref_mode
-- Source:    prisma/schema.prisma
--
-- Snapshot commits can now live on a private ref (refs/shogo/checkpoints/**)
-- instead of the user's checked-out branch. Existing rows keep mode='branch',
-- which is exactly what they are: real commits on `branch`.

-- AlterTable
ALTER TABLE "project_checkpoints" ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'branch',
ADD COLUMN     "refName" TEXT;
