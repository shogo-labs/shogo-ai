-- Migration: add `workspace_grants.planId` (SQLite / desktop variant).
-- Mirror of prisma/migrations/20260518000000_grant_plan_tier/migration.sql.
-- See that file for full semantics.

ALTER TABLE "workspace_grants"
  ADD COLUMN "planId" TEXT;
