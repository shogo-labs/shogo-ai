-- Migration: Project.vmMemoryMiB
-- Source:    prisma/schema.local.prisma
--
-- Desktop/self-hosted keeps the column for schema parity with the cloud track.
-- It is unused there: a local runtime uses the machine's own RAM.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "vmMemoryMiB" INTEGER;
