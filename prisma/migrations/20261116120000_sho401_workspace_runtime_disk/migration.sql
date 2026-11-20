-- Migration: Workspace.runtimeDiskGiB + Workspace.diskAddonBilledThrough.
--
-- runtimeDiskGiB: the workspace-runtime workspace-drive size (GiB) for a bare
-- `ws:<id>` runtime (SHO-401). Nullable: null means the runtime sizes to the
-- largest member project's workspaceDiskGiB. Route-only — only
-- PUT /api/workspaces/:id/disk writes it.
--
-- diskAddonBilledThrough: the UTC day through which the disk add-on has been
-- billed. The daily `disk_addon` job advances it in the same transaction as the
-- debit, so a rerun the same day charges nothing.
--
-- Additive and safe: existing workspaces keep exactly the runtime they have.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "runtimeDiskGiB" INTEGER;
ALTER TABLE "workspaces" ADD COLUMN "diskAddonBilledThrough" TIMESTAMP(3);
