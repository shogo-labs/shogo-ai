-- Migration: project_agents_random_ids
-- Source:    prisma/schema.local.prisma (SQLite)
-- Mirrors prisma/migrations/20261024100000_project_agents_random_ids/migration.sql.
--
-- The desktop tree never ran the cloud backfill: its own
-- `20260508001721_add_project_agents_local` only creates the table, it does
-- not seed `default` rows, so a database that only ever lived in Shogo Desktop
-- has no `pa_default_%` id to rewrite. The rewrite is still here rather than
-- omitted because a desktop database can carry cloud rows (a database copied
-- out of a cloud dev environment, or a project imported with its data), and
-- leaving those ids behind would be a silent divergence between the two
-- tracks — the one thing the desktop/cloud parity rule forbids. On a database
-- that has none it is a no-op, and `bun run check:migrations` replays it on
-- every checkpoint scenario.
--
-- Same two halves as the Postgres migration:
--   1. rewrite `^pa_default_` ids to random ones (`randomblob`, the SQLite
--      equivalent of `gen_random_uuid()`), keeping the `pa_` prefix;
--   2. repoint `conversation_members.projectAgentId` and
--      `conversation_mentions.projectAgentId`, which are bare columns with no
--      foreign key and would otherwise dangle.
--
-- Idempotent: only ids carrying the `pa_default_` prefix are touched, so a
-- replay matches nothing. The map table name is specific to this migration so
-- it can never shadow a real table.
--
-- The `UPDATE ... FROM` form is avoided on purpose: it needs SQLite 3.33+ and
-- nothing else in this tree uses it, so the map is joined with a plain
-- correlated subquery instead.

DROP TABLE IF EXISTS "_sho146_pa_id_map";

CREATE TEMP TABLE "_sho146_pa_id_map" AS
SELECT
  "id"                                        AS old_id,
  'pa_' || lower(hex(randomblob(16)))         AS new_id
FROM "project_agents"
WHERE substr("id", 1, 11) = 'pa_default_';

-- Children first: they still point at the old ids.
UPDATE "conversation_members"
   SET "projectAgentId" = (
         SELECT m.new_id FROM "_sho146_pa_id_map" m
          WHERE m.old_id = "conversation_members"."projectAgentId"
       )
 WHERE "projectAgentId" IN (SELECT old_id FROM "_sho146_pa_id_map");

UPDATE "conversation_mentions"
   SET "projectAgentId" = (
         SELECT m.new_id FROM "_sho146_pa_id_map" m
          WHERE m.old_id = "conversation_mentions"."projectAgentId"
       )
 WHERE "projectAgentId" IN (SELECT old_id FROM "_sho146_pa_id_map");

-- Then the parent.
UPDATE "project_agents"
   SET "id" = (
         SELECT m.new_id FROM "_sho146_pa_id_map" m
          WHERE m.old_id = "project_agents"."id"
       )
 WHERE substr("id", 1, 11) = 'pa_default_';

DROP TABLE IF EXISTS "_sho146_pa_id_map";
