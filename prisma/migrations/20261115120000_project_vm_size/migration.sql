-- Migration: Project.vmMemoryMiB + Project.vmVcpus.
--
-- Per-project guest size for the project's metal microVM. Nullable: null means
-- the fleet's standard VM size (METAL_MEM_MIB / METAL_VCPUS). Additive and
-- safe — existing projects keep exactly the VM they have.
--
-- Operator-set only; the generic project PATCH drops both fields.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "vmMemoryMiB" INTEGER;
ALTER TABLE "projects" ADD COLUMN "vmVcpus" INTEGER;
