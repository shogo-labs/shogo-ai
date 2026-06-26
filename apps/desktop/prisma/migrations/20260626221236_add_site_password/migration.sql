-- Password-protected published sites (desktop / SQLite track).
--
-- Mirrors prisma/migrations/20260626150000_add_site_password (PG). SQLite has
-- no enum, so `accessLevel` already stores the value as TEXT; the only schema
-- change here is the new nullable `sitePasswordHash` column. When accessLevel
-- == "password", apps/api/src/routes/publish.ts stores
-- sha256(`${subdomain}:${password}`) here.
--
-- Additive + nullable -> zero downtime, identical behavior for rows that don't
-- opt in. (Unrelated table redefinitions emitted by `prisma migrate diff` are
-- pre-existing accepted drift and intentionally omitted, matching every prior
-- single-column desktop migration, e.g. 20260617212932_add_published_always_on.)

PRAGMA foreign_keys = OFF;

ALTER TABLE "projects" ADD COLUMN "sitePasswordHash" TEXT;

PRAGMA foreign_keys = ON;
