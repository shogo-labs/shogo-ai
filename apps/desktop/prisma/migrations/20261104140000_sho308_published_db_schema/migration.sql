-- SQLite mirror of prisma/migrations/20261104140000_sho308_published_db_schema
-- (SHO-308 §1). The desktop keeps the same model, so the two schemas stay one
-- model even though a desktop publish never provisions Postgres itself.

ALTER TABLE "published_environments" ADD COLUMN "dbSchema" TEXT;
ALTER TABLE "published_environments" ADD COLUMN "dbSchemaHash" TEXT;
