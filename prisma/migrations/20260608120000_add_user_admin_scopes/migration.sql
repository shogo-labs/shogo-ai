-- Granular admin permission scopes for partial (non-super_admin) admin access.
--
-- Adds users.adminScopes: a list of permission strings (e.g. "analytics:read",
-- "creators:read"). A super_admin implicitly holds every scope, so this column
-- only matters for users granted partial admin access. Values are validated
-- against the catalog in apps/api/src/lib/admin-scopes.ts. Existing rows default
-- to an empty array (no admin scopes).

-- AlterTable
ALTER TABLE "users" ADD COLUMN "adminScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
