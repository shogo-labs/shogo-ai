-- The schema a published environment's Postgres database was built from
-- (SHO-308 §1). Storing it lets a publish classify the app's current schema
-- against what the database actually has: an additive change pushes normally, a
-- destructive one is refused with `destructive_schema_change` unless the caller
-- accepts data loss. `dbSchemaHash` makes an unchanged schema a no-op.

ALTER TABLE "published_environments" ADD COLUMN "dbSchema" TEXT;
ALTER TABLE "published_environments" ADD COLUMN "dbSchemaHash" TEXT;
