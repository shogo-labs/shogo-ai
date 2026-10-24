// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Acceptance tests for SHO-146.
 *
 * `20260507000000_add_project_agents` backfilled one `default` agent per
 * `voice_project_configs` row with `'pa_default_' || "voice_project_configs"."id"`
 * — a primary key computed from replicated row content, the same mechanism that
 * took US -> EU replication down on 2026-10-22. `20261024100000_project_agents_random_ids`
 * repairs it forward (the applied migration file cannot be rewritten) and
 * `conversation_members.projectAgentId` / `conversation_mentions.projectAgentId`
 * are bare columns with no FK, so they have to be repointed in the same
 * migration or they silently orphan.
 *
 * Two things are worth proving here and the guard's unit tests cannot prove:
 *
 *   1. the repair actually rewrites the *data* on a real database, and
 *   2. two databases seeded identically end up with *different* ids — that is
 *      the whole property. "Repaired" that still produced a deterministic id
 *      would be the same landmine in a new spelling.
 *
 * The SQLite twin is exercised for real (all 153 desktop migrations replayed,
 * then rows seeded, then the twin applied) because `check:migrations` only ever
 * replays it against empty databases, where the rewrite matches no rows.
 */
import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const DESKTOP_MIGRATIONS = join(REPO_ROOT, 'apps/desktop/prisma/migrations')
const PG_MIGRATIONS = join(REPO_ROOT, 'prisma/migrations')
const REPAIR = '20261024100000_project_agents_random_ids'

function migrationNames(root: string): string[] {
  return readdirSync(root)
    .filter((name) => existsSync(join(root, name, 'migration.sql')))
    .sort()
}

function sqlOf(root: string, name: string): string {
  return readFileSync(join(root, name, 'migration.sql'), 'utf-8')
}

/** Drop `--` and block comments, so assertions read the executable SQL only. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}

/**
 * A desktop database at the moment the repair lands: every migration before it
 * applied, and the cloud-shaped rows the May backfill used to write.
 */
function seededDesktopDb(): Database {
  const db = new Database(':memory:')
  for (const name of migrationNames(DESKTOP_MIGRATIONS)) {
    if (name === REPAIR) continue
    db.exec(sqlOf(DESKTOP_MIGRATIONS, name))
  }

  db.exec(`
    INSERT INTO "workspaces" ("id","name","slug","updatedAt") VALUES ('ws_qa','QA','qa','2026-05-07 00:00:00');
    INSERT INTO "projects" ("id","name","workspaceId","updatedAt") VALUES ('proj_qa','QA','ws_qa','2026-05-07 00:00:00');
    INSERT INTO "users" ("id","email","updatedAt") VALUES ('usr_qa','qa@example.test','2026-05-07 00:00:00');
    INSERT INTO "voice_project_configs" ("id","projectId","workspaceId","updatedAt") VALUES ('cfg_sim','proj_qa','ws_qa','2026-05-07 00:00:00');
    INSERT INTO "conversations" ("id","workspaceId","updatedAt") VALUES ('conv_qa','ws_qa','2026-05-07 00:00:00');
    INSERT INTO "conversation_messages" ("id","conversationId","workspaceId","seq","text","updatedAt") VALUES ('msg_qa','conv_qa','ws_qa',1,'hi','2026-05-07 00:00:00');

    -- the May backfill, verbatim
    INSERT INTO "project_agents" ("id","projectId","workspaceId","name","updatedAt")
      SELECT 'pa_default_' || "id", "projectId", "workspaceId", 'default', '2026-05-07 00:00:00'
      FROM "voice_project_configs";

    INSERT INTO "conversation_members" ("id","conversationId","memberType","projectAgentId","updatedAt")
      VALUES ('mem_qa','conv_qa','agent','pa_default_cfg_sim','2026-05-07 00:00:00');
    INSERT INTO "conversation_mentions" ("id","messageId","targetType","projectAgentId")
      VALUES ('men_qa','msg_qa','agent','pa_default_cfg_sim');
  `)

  return db
}

function agentIds(db: Database): string[] {
  return db.query<{ id: string }, []>('SELECT "id" FROM "project_agents"').all().map((r) => r.id)
}

function childPointers(db: Database): {
  table: string
  row: string
  projectAgentId: string | null
  resolves: number
}[] {
  return [
    ...db
      .query<{ id: string; projectAgentId: string | null; resolves: number }, []>(
        `SELECT m."id" AS id, m."projectAgentId" AS projectAgentId,
                (SELECT count(*) FROM "project_agents" p WHERE p."id" = m."projectAgentId") AS resolves
           FROM "conversation_members" m`,
      )
      .all()
      .map((r) => ({ table: 'conversation_members', row: r.id, ...r })),
    ...db
      .query<{ id: string; projectAgentId: string | null; resolves: number }, []>(
        `SELECT n."id" AS id, n."projectAgentId" AS projectAgentId,
                (SELECT count(*) FROM "project_agents" p WHERE p."id" = n."projectAgentId") AS resolves
           FROM "conversation_mentions" n`,
      )
      .all()
      .map((r) => ({ table: 'conversation_mentions', row: r.id, ...r })),
  ]
}

describe('SHO-146 acceptance: the derived project_agents ids are repaired', () => {
  test('AC1 — the desktop twin rewrites ^pa_default_ ids and repoints both child tables', () => {
    const db = seededDesktopDb()
    expect(agentIds(db)).toEqual(['pa_default_cfg_sim'])

    db.exec(sqlOf(DESKTOP_MIGRATIONS, REPAIR))

    const [id] = agentIds(db)
    // Random, and not derived from `voice_project_configs.id` in any spelling.
    expect(id).toMatch(/^pa_[0-9a-f]{32}$/)
    expect(id).not.toContain('cfg_sim')

    const children = childPointers(db)
    expect(children).toHaveLength(2)
    for (const child of children) {
      expect(child.projectAgentId).toBe(id)
      // A bare column with no FK: "renamed" only counts if it still resolves.
      expect(child.resolves).toBe(1)
    }
  })

  test('AC1 — the repair is idempotent: a replay matches nothing and changes nothing', () => {
    const db = seededDesktopDb()
    db.exec(sqlOf(DESKTOP_MIGRATIONS, REPAIR))
    const before = agentIds(db)

    db.exec(sqlOf(DESKTOP_MIGRATIONS, REPAIR))

    expect(agentIds(db)).toEqual(before)
    for (const child of childPointers(db)) expect(child.resolves).toBe(1)
  })

  test('the whole point: two databases that saw the same rows repair to different ids', () => {
    // Identical seeds, independent repairs. If the replacement were derived
    // from `voice_project_configs.id` — or from anything else the two regions
    // both hold — these would still agree and the next tablesync would collide
    // exactly as it did on 2026-10-22.
    const a = seededDesktopDb()
    const b = seededDesktopDb()
    a.exec(sqlOf(DESKTOP_MIGRATIONS, REPAIR))
    b.exec(sqlOf(DESKTOP_MIGRATIONS, REPAIR))

    expect(agentIds(a)[0]).not.toBe(agentIds(b)[0])
  })

  test('the twin is a no-op on a desktop-only database (no backfilled rows exist there)', () => {
    const db = new Database(':memory:')
    for (const name of migrationNames(DESKTOP_MIGRATIONS)) {
      if (name === REPAIR) continue
      db.exec(sqlOf(DESKTOP_MIGRATIONS, name))
    }
    expect(agentIds(db)).toEqual([])

    expect(() => db.exec(sqlOf(DESKTOP_MIGRATIONS, REPAIR))).not.toThrow()
    expect(agentIds(db)).toEqual([])
  })
})

describe('SHO-146 acceptance: the Postgres migration keeps the same two halves', () => {
  const pg = sqlOf(PG_MIGRATIONS, REPAIR)

  test('AC3 — both tracks carry the repair, so neither is a desktop-only or cloud-only fix', () => {
    expect(migrationNames(PG_MIGRATIONS)).toContain(REPAIR)
    expect(migrationNames(DESKTOP_MIGRATIONS)).toContain(REPAIR)
  })

  test('it is prefix-gated, so a replay on an already-repaired database is a no-op', () => {
    // Comments describe the incident, so only the executable SQL is asserted on.
    const sql = stripSqlComments(pg)
    expect(sql).toContain(`"id" ~ '^pa_default_'`)
    expect(sql).toContain('gen_random_uuid()')
    expect(sql).not.toContain("'pa_default_' ||")
  })

  test('it repoints both bare child columns, children first, in the same file', () => {
    const members = pg.indexOf('"conversation_members"')
    const mentions = pg.indexOf('"conversation_mentions"')
    const parents = pg.indexOf('UPDATE "project_agents"')
    expect(members).toBeGreaterThan(-1)
    expect(mentions).toBeGreaterThan(-1)
    // Children must be repointed before the parent id moves, or the UPDATE of
    // the child would find nothing to match.
    expect(members).toBeLessThan(parents)
    expect(mentions).toBeLessThan(parents)
  })
})
