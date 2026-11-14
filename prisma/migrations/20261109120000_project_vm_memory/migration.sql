-- Migration: Project.vmMemoryMiB.
--
-- Per-project guest memory (MiB) for the project's metal microVM. Nullable:
-- null means the fleet's standard VM size (METAL_MEM_MIB). Additive and safe —
-- existing projects keep exactly the VM they have.
--
-- Operator-set only; the generic project PATCH drops the field.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "vmMemoryMiB" INTEGER;
