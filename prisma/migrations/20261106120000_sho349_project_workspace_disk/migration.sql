-- Migration: Project.workspaceDiskGiB (SHO-349).
--
-- Per-project workspace-drive size (GiB), grown live on a metal host
-- (fsfreeze -> ftruncate -> PATCH /drives -> resize2fs). Nullable: null means
-- "use the fleet default" (METAL_WORKSPACE_DRIVE_MIB). Additive and safe —
-- existing projects keep exactly the drive they have.
--
-- Written ONLY by PUT /api/projects/:id/disk (role + tier ceiling checks);
-- the generic project PATCH drops the field.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "workspaceDiskGiB" INTEGER;
