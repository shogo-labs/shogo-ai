// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for `scripts/check-migration-derived-ids.ts`.
 *
 * The guard exists because of the 2026-10-22 outage (SHO-142): a migration
 * backfilled `device_version_events` ids as `'dve_' || md5(deviceId, version)`
 * on a published table. Both regions recomputed the same keys from the same
 * replicated rows, EU's tablesync COPY died on a duplicate primary key, and
 * `sub_from_us` was disabled for 25 minutes. The cases below pin the two
 * halves that matter — it fires on that shape, and it does not fire on the
 * shapes that are safe (random ids, region-scoped keys, INSERTs that leave
 * `id` to `@default(cuid())`).
 */

import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  LEGACY_EXEMPT,
  checkMigrationSources,
  extractWrittenId,
  isDerivedExpression,
  splitTopLevel,
  type MigrationSource,
} from '../check-migration-derived-ids'

const REPO_ROOT = resolve(import.meta.dir, '../..')

function check(sql: string, name = '20260101000000_fixture'): ReturnType<typeof checkMigrationSources> {
  return checkMigrationSources([{ name, sql }] as MigrationSource[], 'fixtures/')
}

// ===========================================================================
// The real tree passes — this is the CI gate itself.
// ===========================================================================

describe('check-migration-derived-ids (e2e, current repo state)', () => {
  test('exits 0 against the real migration tree', () => {
    const proc = spawnSync('bun', ['scripts/check-migration-derived-ids.ts', '--quiet'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    })
    if (proc.status !== 0) {
      throw new Error(
        `expected exit 0, got ${proc.status}\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
      )
    }
    expect(proc.status).toBe(0)
  })

  test('the guard has teeth: the 2026-10-22 backfill fails when it is not exempt', () => {
    const sql = readFileSync(
      resolve(REPO_ROOT, 'prisma/migrations/20261021120000_add_device_version_events/migration.sql'),
      'utf-8',
    )
    const violations = check(sql, '20260101000000_not_exempt')
    expect(violations.length).toBe(1)
    expect(violations[0].table).toBe('device_version_events')
    expect(violations[0].expression).toContain('md5(')
  })

  test('the exemption list is exactly the two known historical offenders', () => {
    expect([...LEGACY_EXEMPT]).toEqual([
      '20261021120000_add_device_version_events',
      '20260507000000_add_project_agents',
    ])
  })
})

// ===========================================================================
// Fails: a derived id into a published table.
// ===========================================================================

describe('derived ids into a published table', () => {
  test('md5 of row columns in an INSERT ... SELECT fails', () => {
    const violations = check(`
      INSERT INTO "device_version_events" ("id", "deviceId", "version")
      SELECT 'dve_' || md5(k."deviceId" || ':' || k."deviceAppVersion"), k."deviceId", k."deviceAppVersion"
      FROM "api_keys" k;
    `)
    expect(violations).toHaveLength(1)
    expect(violations[0].file).toBe('fixtures/20260101000000_fixture/migration.sql')
    expect(violations[0].table).toBe('device_version_events')
    expect(violations[0].expression).toContain('md5(')
    expect(violations[0].line).toBe(2)
  })

  test('a deterministic prefix concatenated with a replicated column fails', () => {
    // The shape the guard found in 20260507000000_add_project_agents.
    const violations = check(`
      INSERT INTO "project_agents" ("id", "projectId", "name")
      SELECT 'pa_default_' || "id", "projectId", 'default'
      FROM "voice_project_configs";
    `)
    expect(violations).toHaveLength(1)
    expect(violations[0].expression).toContain('"id"')
  })

  test('sha256 / digest / encode are caught too', () => {
    for (const fn of ['sha256', 'digest', 'encode']) {
      const violations = check(`
        INSERT INTO "things" ("id", "name") SELECT ${fn}("name"), "name" FROM "users";
      `)
      expect(violations).toHaveLength(1)
    }
  })

  test('an UPDATE that rewrites id from a column fails', () => {
    const violations = check(`
      UPDATE "things" SET "id" = 'x_' || "oldId" WHERE "id" LIKE 'y%';
    `)
    expect(violations).toHaveLength(1)
    expect(violations[0].expression).toBe(`'x_' || "oldId"`)
  })

  test('a VALUES tuple deriving the id fails', () => {
    const violations = check(`
      INSERT INTO "things" ("name", "id") VALUES ('a', md5('a'));
    `)
    expect(violations).toHaveLength(1)
    expect(violations[0].expression).toBe("md5('a')")
  })

  test('a bare column copy fails, through INSERT ... SELECT and UPDATE', () => {
    const inserted = check(`
      INSERT INTO "device_version_events" ("id", "deviceId") SELECT "deviceId", "deviceId" FROM "api_keys";
    `)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].expression).toBe('"deviceId"')

    const updated = check(`
      UPDATE "device_version_events" SET "id" = "deviceId" WHERE "id" IS NULL;
    `)
    expect(updated).toHaveLength(1)
    expect(updated[0].expression).toBe('"deviceId"')
  })
})

// ===========================================================================
// Passes: the shapes that are actually safe.
// ===========================================================================

describe('safe shapes', () => {
  test('region-unpublished tables may derive ids (they are never copied)', () => {
    // INTENTIONALLY_UNPUBLISHED comes from check-publication-drift.ts, so this
    // also pins the "one source of truth" wiring.
    const violations = check(`
      INSERT INTO "usage_wallets" ("id", "workspaceId")
      SELECT 'uw_' || md5("workspaceId"), "workspaceId" FROM "workspaces";
    `)
    expect(violations).toEqual([])
  })

  test('gen_random_uuid() is not derived from row content', () => {
    const violations = check(`
      UPDATE "device_version_events" SET "id" = 'dve_' || gen_random_uuid()::text
      WHERE "id" ~ '^dve_[0-9a-f]{32}$';
    `)
    expect(violations).toEqual([])
  })

  test('SQLite randomblob() is not derived from row content', () => {
    const violations = check(`
      INSERT INTO "device_version_events" ("id", "deviceId")
      SELECT 'dve_' || lower(hex(randomblob(10))), k."deviceId" FROM "api_keys" k;
    `)
    expect(violations).toEqual([])
  })

  test('a literal / cuid() / uuid_generate_v4() id passes', () => {
    for (const expression of ["'fixed'", 'cuid()', 'uuid_generate_v4()', 'gen_random_uuid()']) {
      const violations = check(`
        INSERT INTO "things" ("id", "name") SELECT ${expression}, "name" FROM "users";
      `)
      expect(violations).toEqual([])
    }
  })

  test('a plain INSERT ... SELECT that leaves id to @default(cuid()) passes', () => {
    const violations = check(`
      INSERT INTO "device_version_events" ("deviceId", "version", "lastSeenAt")
      SELECT k."deviceId", k."deviceAppVersion", now() FROM "api_keys" k;
    `)
    expect(violations).toEqual([])
  })

  test('DDL and index changes pass', () => {
    const violations = check(`
      ALTER TABLE "device_version_events" ADD COLUMN "region" TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS "device_version_events_region_deviceId_version_key"
        ON "device_version_events" ("region", "deviceId", "version");
    `)
    expect(violations).toEqual([])
  })

  test('a derived id inside a comment is ignored', () => {
    const violations = check(`
      -- SELECT 'dve_' || md5("deviceId") was the old way
      /* INSERT INTO "things" ("id") SELECT md5("name") FROM "users"; */
      SELECT 1;
    `)
    expect(violations).toEqual([])
  })
})

// ===========================================================================
// Parsing helpers — a parser regression here would silently disarm the guard.
// ===========================================================================

describe('extractWrittenId', () => {
  test('finds the id expression by column position, not by luck', () => {
    expect(
      extractWrittenId(
        `INSERT INTO "t" ("a", "id", "b") SELECT "x", md5("y"), "z" FROM "u"`,
      ),
    ).toEqual({ table: 't', expression: 'md5("y")' })
  })

  test('returns null when id is not written', () => {
    expect(extractWrittenId(`INSERT INTO "t" ("a", "b") SELECT "x", "y" FROM "u"`)).toBeNull()
  })

  test('ignores a WHERE clause when reading the UPDATE expression', () => {
    // Regression: the predicate used to be swallowed into the expression, so a
    // safe `gen_random_uuid()` looked like it referenced a column.
    expect(
      extractWrittenId(
        `UPDATE "t" SET "id" = 'p_' || gen_random_uuid()::text WHERE "id" ~ '^p_'`,
      ),
    ).toEqual({ table: 't', expression: `'p_' || gen_random_uuid()::text` })
  })

  test('handles a schema-qualified table', () => {
    expect(extractWrittenId(`INSERT INTO public."t" ("id") SELECT md5('x')`)).toEqual({
      table: 't',
      expression: "md5('x')",
    })
  })
})

describe('isDerivedExpression', () => {
  test('hash functions count, random ones do not', () => {
    expect(isDerivedExpression('md5("a")')).toBe(true)
    expect(isDerivedExpression('gen_random_uuid()')).toBe(false)
    expect(isDerivedExpression(`'p_' || gen_random_uuid()::text`)).toBe(false)
    expect(isDerivedExpression(`'p_' || "a"`)).toBe(true)
  })

  test('a bare column copy is derived, however it is spelled', () => {
    // The shapes the first cut missed (SHO-142 QA round 1, N3).
    expect(isDerivedExpression('"deviceId"')).toBe(true)
    expect(isDerivedExpression('deviceId')).toBe(true)
    expect(isDerivedExpression(`coalesce("a", gen_random_uuid()::text)`)).toBe(true)
    expect(isDerivedExpression(`lower("a")`)).toBe(true)
  })

  test('a literal is not, even when it contains a quoted word', () => {
    expect(isDerivedExpression(`'say "hi"'`)).toBe(false)
    expect(isDerivedExpression(`'it''s "quoted"'`)).toBe(false)
    expect(isDerivedExpression('NULL')).toBe(false)
    expect(isDerivedExpression('DEFAULT')).toBe(false)
  })
})

describe('splitTopLevel', () => {
  test('respects parens and string literals', () => {
    expect(splitTopLevel(`a, coalesce(b, c), 'd, e'`)).toEqual(['a', ' coalesce(b, c)', ` 'd, e'`])
  })
})
