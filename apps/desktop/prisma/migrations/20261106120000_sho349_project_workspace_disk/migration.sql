-- Migration: SHO-349 Project.workspaceDiskGiB
-- Source:    prisma/schema.local.prisma
--
-- Desktop/self-hosted keeps the column for schema parity with the cloud track.
-- The value is read-only there: a local runtime uses the machine's own disk, so
-- there is nothing to grow (see GET /api/projects/:id/disk -> substrate 'local').

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "workspaceDiskGiB" INTEGER;
