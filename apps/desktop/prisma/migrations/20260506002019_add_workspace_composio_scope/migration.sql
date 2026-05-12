-- Migration: add workspaces.composioScope (SQLite / desktop variant).
-- Mirror of prisma/migrations/20260506002019_add_workspace_composio_scope/migration.sql
-- but rewritten for SQLite syntax — no NOW(), no per-row UPDATE branch
-- needed because SQLite ALTER TABLE ... ADD COLUMN with a DEFAULT only
-- materializes the default for newly-inserted rows; existing rows remain
-- NULL until written, which the app code coerces to DEFAULT_COMPOSIO_SCOPE
-- ('workspace'). Existing workspaces should keep their pre-migration
-- behavior, so we explicitly backfill them to 'project'.

ALTER TABLE "workspaces"
  ADD COLUMN "composioScope" TEXT NOT NULL DEFAULT 'workspace';

UPDATE "workspaces"
  SET "composioScope" = 'project';
