-- Migration: Project.vmMemoryMiB + Project.vmVcpus
-- Source:    prisma/schema.local.prisma
--
-- Desktop/self-hosted keeps the columns for schema parity with the cloud track.
-- They are unused there: a local runtime uses the machine's own CPU and RAM.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "vmMemoryMiB" INTEGER;
ALTER TABLE "projects" ADD COLUMN "vmVcpus" INTEGER;
