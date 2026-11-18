-- Migration: Workspace.runtimeDiskGiB + Workspace.diskAddonBilledThrough
-- Source:    prisma/schema.local.prisma
--
-- Desktop/self-hosted keeps the columns for schema parity with the cloud track.
-- runtimeDiskGiB is unused there (a local runtime uses the machine's own disk);
-- diskAddonBilledThrough is unused because local mode has no billing job.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "runtimeDiskGiB" INTEGER;
ALTER TABLE "workspaces" ADD COLUMN "diskAddonBilledThrough" DATETIME;
