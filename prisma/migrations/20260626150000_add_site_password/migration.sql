-- Password-protected published sites.
--
-- Adds a new `password` access level and a per-project password hash. When
-- accessLevel == 'password', apps/api/src/routes/publish.ts stores
-- sha256(`${subdomain}:${password}`) here and mirrors it to the SITE_AUTH
-- Cloudflare KV namespace so the *.shogo.one edge Worker can gate visitors.
-- Both changes are additive (new enum value + nullable column) -> zero downtime.

-- AlterEnum
ALTER TYPE "AccessLevel" ADD VALUE 'password';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "sitePasswordHash" TEXT;
