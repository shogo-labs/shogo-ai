-- Migration: rename `feature.shogo_mode` -> `feature.ez_mode` in
-- `platform_settings` (SQLite / desktop variant).
-- Mirror of prisma/migrations/20260519000000_rename_shogo_mode_flag/migration.sql.

UPDATE "platform_settings"
  SET "key" = 'feature.ez_mode'
  WHERE "key" = 'feature.shogo_mode';
