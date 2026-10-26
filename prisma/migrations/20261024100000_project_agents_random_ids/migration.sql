-- Migration: project_agents_random_ids
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same columns; see the SQLite twin)
--
-- Why (SHO-146)
-- -------------
-- `20260507000000_add_project_agents` backfilled one `default` agent per
-- existing `voice_project_configs` row with
--
--   "id" = 'pa_default_' || "voice_project_configs"."id"
--
-- `project_agents` is in `shogo_all_pub` (`tablesInSchema: public`) and
-- `voice_project_configs` was already replicated, so both regions ran that
-- backfill against the same rows and minted the *same* primary keys — the
-- identical mechanism as the `dve_` md5 ids that took US -> EU replication
-- down on 2026-10-22, just applied three months earlier. Nothing has collided
-- yet because the two regions hold the same ids, which is exactly what makes
-- it a landmine rather than a live bug: a restore, a region rebuild or a
-- re-added table makes the peer's tablesync `COPY` land a second row for a
-- key that already exists, and `conflict-watchdog` cannot skip a tablesync
-- duplicate.
--
-- What this does
-- --------------
-- 1. **Rewrites the derived ids to random**, keeping only the `pa_` prefix.
--    Same shape as `20261022120000_device_version_events_region_ids`: the
--    replacement references no column, so no two regions can ever agree on it
--    again. New rows already rely on the model's `@default(cuid())`; nothing
--    in the codebase passes `id`.
--
-- 2. **Remaps the child pointers in the same migration.**
--    `conversation_members.projectAgentId` and
--    `conversation_mentions.projectAgentId` are bare columns — no foreign
--    key, no cascade — so renaming a parent id would silently orphan them.
--    The id map is captured *before* the rewrite and both children are
--    repointed before the parent moves, so a reader never sees a dangling
--    value mid-migration.
--
-- Idempotent: only ids matching `^pa_default_` are touched, so a replay (or a
-- region whose copy was already rewritten) matches nothing and is a no-op.
-- The map table carries an SHO-146-specific name so it can never shadow — or
-- be shadowed by — a real table.
--
-- Why the map identifiers are unquoted
-- ------------------------------------
-- `scripts/check-migration-derived-ids.ts` treats *any* quoted identifier in
-- the expression assigned to `id` as a read of row content, because it cannot
-- tell a column read from the rest of a `SELECT`. `pa_id_map.new_id` is
-- `gen_random_uuid()` — random, not derived — and the join only decides
-- *which* random value each row gets, so the statement is safe; writing the
-- scaffold table and its columns unquoted (standard SQL, lowercase, and the
-- only names in the statement that are not Prisma's column style) keeps that
-- fact visible to the guard. Do not "tidy" them into `"..."` — the guard will
-- (correctly, by its own rule) reject the file.
--
-- Consequence we accept
-- ---------------------
-- Each region rewrites its own copies to its own random ids, so a `default`
-- agent that exists in both regions ends up with a *different* id on each
-- side. A peer's `UPDATE` for that row then finds no local row and
-- `conflict-watchdog` skips the transaction. That is tolerable here because a
-- `project_agents` row is not edited by id across regions: `POST
-- /api/projects/:id/agents/sync` upserts on `(projectId, name)`, so every
-- region rebuilds the row's content from its own `shogo deploy` config. This
-- is the same trade `20261022120000` made for `device_version_events`, minus
-- the second row (see the note on the unique index below).
--
-- NOT fixed here: `project_agents` also carries a unique index on
-- `(projectId, name)` — non-region-scoped, which RUNBOOK «Multi-region
-- migration rules» §2 calls the same poison pill. A peer's tablesync of one
-- logical agent still cannot be arbitrated. That predates this migration (it
-- fails on the primary key today) and gets no worse with random ids, but it
-- needs a `region` column in the key and its own card; SHO-146 is only about
-- removing the content-derived id.

-- Capture (old id -> new random id) before anything moves. The child pointers
-- below resolve through this table so both halves of the rename land together.
-- Dropped explicitly at the end rather than with `ON COMMIT DROP`, so the file
-- also survives a runner that does not wrap the migration in a transaction.
DROP TABLE IF EXISTS _sho146_pa_id_map;

CREATE TEMP TABLE _sho146_pa_id_map AS
SELECT
  "id"                             AS old_id,
  'pa_' || gen_random_uuid()::text AS new_id
FROM "project_agents"
WHERE "id" ~ '^pa_default_';

-- Children first: they still point at the old ids.
UPDATE "conversation_members"
   SET "projectAgentId" = m.new_id
  FROM _sho146_pa_id_map m
 WHERE "conversation_members"."projectAgentId" = m.old_id;

UPDATE "conversation_mentions"
   SET "projectAgentId" = m.new_id
  FROM _sho146_pa_id_map m
 WHERE "conversation_mentions"."projectAgentId" = m.old_id;

-- Then the parent. `m.new_id` is the random value assigned above, so the
-- derived `'pa_default_' || voice_project_configs.id` relation is gone.
UPDATE "project_agents"
   SET "id" = m.new_id
  FROM _sho146_pa_id_map m
 WHERE "project_agents"."id" = m.old_id;

DROP TABLE IF EXISTS _sho146_pa_id_map;
