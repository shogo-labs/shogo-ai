-- Migration: add_instance_user_id
-- Source:    prisma/schema.local.prisma
--
-- Scope machines to the user who paired them (SQLite / desktop track).
--
-- The instances statements below are exactly what
--   prisma migrate diff --from-migrations apps/desktop/prisma/migrations \
--     --to-schema prisma/schema.local.prisma --script
-- emits for the `instances` table. They are extracted verbatim and shipped
-- on their own (rather than the full diff) so this migration does not also
-- rebuild the unrelated tables that are pre-existing accepted drift (see
-- ACCEPTED_DRIFT in scripts/check-desktop-schema-drift.ts). After this
-- migration the `instances` table matches schema.local.prisma, so the drift
-- check no longer reports it.

-- DropIndex
DROP INDEX "instances_workspaceId_hostname_key";

-- AlterTable
ALTER TABLE "instances" ADD COLUMN "userId" TEXT;

-- Reset legacy rows whose owner is unknowable; they re-register (owned) on
-- the next heartbeat. projects.preferredInstanceId is ON DELETE SET NULL.
DELETE FROM "instances";

-- CreateIndex
CREATE INDEX "instances_workspaceId_userId_idx" ON "instances"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "instances_workspaceId_userId_hostname_key" ON "instances"("workspaceId", "userId", "hostname");
