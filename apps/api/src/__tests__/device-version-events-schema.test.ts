// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Schema + migration parity for `DeviceVersionEvent`.
 *
 * The model backs version adoption in admin analytics, so it has to exist on
 * both tracks (cloud Postgres and the desktop's SQLite) with the same shape —
 * no allow-list entries, per the "desktop and cloud must never diverge" rule.
 * These assertions fail fast instead of letting a one-sided schema reach a
 * release, where the desktop app would silently lose adoption history.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const MIGRATION_ID = '20261021120000_add_device_version_events'
const REGION_MIGRATION_ID = '20261022120000_device_version_events_region_ids'

const PG_SCHEMA = readFileSync(resolve(REPO_ROOT, 'prisma/schema.prisma'), 'utf-8')
const LOCAL_SCHEMA = readFileSync(resolve(REPO_ROOT, 'prisma/schema.local.prisma'), 'utf-8')
const PG_MIGRATION_PATH = resolve(REPO_ROOT, `prisma/migrations/${MIGRATION_ID}/migration.sql`)
const SQLITE_MIGRATION_PATH = resolve(REPO_ROOT, `apps/desktop/prisma/migrations/${MIGRATION_ID}/migration.sql`)
const PG_REGION_MIGRATION_PATH = resolve(REPO_ROOT, `prisma/migrations/${REGION_MIGRATION_ID}/migration.sql`)
const SQLITE_REGION_MIGRATION_PATH = resolve(
  REPO_ROOT,
  `apps/desktop/prisma/migrations/${REGION_MIGRATION_ID}/migration.sql`,
)

function modelBlock(src: string, name: string): string {
  const re = new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm')
  const match = re.exec(src)
  if (!match) throw new Error(`model ${name} not found`)
  return match[1]
}

/** Field declarations only — indentation and field-type alignment differ. */
function fieldsOf(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !line.startsWith('///') && !line.startsWith('@@'))
}

describe('DeviceVersionEvent schema', () => {
  test('is declared in both the cloud and the local schema', () => {
    expect(PG_SCHEMA).toMatch(/model\s+DeviceVersionEvent\s*\{/)
    expect(LOCAL_SCHEMA).toMatch(/model\s+DeviceVersionEvent\s*\{/)
  })

  test('has identical fields on both tracks', () => {
    expect(fieldsOf(modelBlock(LOCAL_SCHEMA, 'DeviceVersionEvent'))).toEqual(
      fieldsOf(modelBlock(PG_SCHEMA, 'DeviceVersionEvent')),
    )
  })

  test('keeps one row per (region, device, version) and indexes the analytics reads', () => {
    for (const schema of [PG_SCHEMA, LOCAL_SCHEMA]) {
      const block = modelBlock(schema, 'DeviceVersionEvent')
      // `region` is in the key: two regions each hold their own tag for one
      // (device, version) instead of colliding on it (SHO-142).
      expect(block).toContain('@@unique([region, deviceId, version])')
      expect(block).not.toContain('@@unique([deviceId, version])')
      expect(block).toContain('@@index([lastSeenAt])')
      expect(block).toContain('@@index([version])')
      expect(block).toContain('@@map("device_version_events")')
    }
  })

  test('region is nullable on both tracks and is never the derived id', () => {
    for (const schema of [PG_SCHEMA, LOCAL_SCHEMA]) {
      const block = modelBlock(schema, 'DeviceVersionEvent')
      // Nullable: pre-region rows keep NULL, which a unique index treats as
      // distinct, so legacy rows can never collide across regions.
      expect(block).toMatch(/^\s*region\s+String\?\s*$/m)
      expect(block).toMatch(/^\s*id\s+String\s+@id\s+@default\(cuid\(\)\)\s*$/m)
    }
  })
})

describe('DeviceVersionEvent migrations', () => {
  test('exist on both tracks under the same migration id', () => {
    expect(existsSync(PG_MIGRATION_PATH)).toBe(true)
    expect(existsSync(SQLITE_MIGRATION_PATH)).toBe(true)
  })

  test('both create the table with the composite unique index', () => {
    for (const path of [PG_MIGRATION_PATH, SQLITE_MIGRATION_PATH]) {
      const sql = readFileSync(path, 'utf-8')
      expect(sql).toContain('CREATE TABLE "device_version_events"')
      expect(sql).toContain('CREATE UNIQUE INDEX "device_version_events_deviceId_version_key"')
      expect(sql).toContain('CREATE INDEX "device_version_events_lastSeenAt_idx"')
      expect(sql).toContain('CREATE INDEX "device_version_events_version_idx"')
    }
  })

  test('both backfill from the live device keys already in api_keys', () => {
    for (const path of [PG_MIGRATION_PATH, SQLITE_MIGRATION_PATH]) {
      const sql = readFileSync(path, 'utf-8')
      expect(sql).toMatch(/INSERT INTO "device_version_events"/)
      expect(sql).toContain(`FROM "api_keys" k`)
      expect(sql).toContain(`k."kind" = 'device'`)
      expect(sql).toContain(`k."revokedAt" IS NULL`)
      // Normalised at backfill time, not the raw platform spelling.
      expect(sql).toContain(`THEN 'macos'`)
      expect(sql).toContain(`THEN 'windows'`)
      expect(sql).toContain(`THEN 'cli'`)
      expect(sql).toContain(`THEN 'beta'`)
    }
  })

  test('the SQLite backfill groups by (device, version) so the unique index holds', () => {
    const sql = readFileSync(SQLITE_MIGRATION_PATH, 'utf-8')
    expect(sql).toMatch(/GROUP BY k\."deviceId", k\."deviceAppVersion"/)
  })
})

/**
 * The forward fix (SHO-142): the md5 backfill above is applied history in both
 * regions, so it stays untouched and this migration repairs the data and the
 * key. History is not rewritten — these assertions deliberately pin both.
 */
describe('DeviceVersionEvent region migration', () => {
  test('exists on both tracks under the same migration id', () => {
    expect(existsSync(PG_REGION_MIGRATION_PATH)).toBe(true)
    expect(existsSync(SQLITE_REGION_MIGRATION_PATH)).toBe(true)
  })

  test('both tracks add the nullable region column and re-scope the unique index', () => {
    for (const path of [PG_REGION_MIGRATION_PATH, SQLITE_REGION_MIGRATION_PATH]) {
      const sql = readFileSync(path, 'utf-8')
      expect(sql).toMatch(/ALTER TABLE "device_version_events" ADD COLUMN (IF NOT EXISTS )?"region" TEXT/)
      expect(sql).not.toMatch(/ADD COLUMN (IF NOT EXISTS )?"region" TEXT NOT NULL/)
      expect(sql).toContain('DROP INDEX IF EXISTS "device_version_events_deviceId_version_key"')
      expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "device_version_events_region_deviceId_version_key"')
      expect(sql).toMatch(/ON "device_version_events" \("region", "deviceId", "version"\)/)
      // No region backfill: both regions would otherwise get the same
      // ('legacy', deviceId, version) key and re-run the outage on publish.
      expect(sql).not.toMatch(/UPDATE "device_version_events"\s+SET "region"/)
    }
  })

  test('the Postgres migration is re-runnable end to end', () => {
    const sql = readFileSync(PG_REGION_MIGRATION_PATH, 'utf-8')
    // Every statement is guarded: ADD COLUMN IF NOT EXISTS, a WHERE that only
    // matches the legacy md5 form, DROP INDEX IF EXISTS, CREATE INDEX IF NOT
    // EXISTS. The desktop twin cannot match this (SQLite has no
    // ADD COLUMN IF NOT EXISTS); it relies on Prisma's migration ledger, which
    // `check:migrations` exercises across 5 upgrade checkpoints.
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "region" TEXT')
    expect(sql).toContain('DROP INDEX IF EXISTS')
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS')
  })

  test('Postgres rewrites only md5-derived ids, and the rewrite is idempotent', () => {
    const sql = readFileSync(PG_REGION_MIGRATION_PATH, 'utf-8')
    // Executable SQL only — the header explains the old md5 backfill.
    const executable = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
    // The rewrite is random and references no column.
    expect(executable).toMatch(/"id" = 'dve_' \|\| gen_random_uuid\(\)::text/)
    expect(executable).not.toMatch(/md5\(/)
    // Only the 32-hex legacy form matches. New ids carry the uuid's dashes, so
    // a second run of the migration matches nothing.
    expect(executable).toContain(`WHERE "id" ~ '^dve_[0-9a-f]{32}$'`)
    const legacyPattern = /^dve_[0-9a-f]{32}$/
    expect(legacyPattern.test('dve_' + 'a'.repeat(32))).toBe(true)
    expect(legacyPattern.test('dve_2b5f0f6e-9d5c-4a51-9d1c-1f7c1a2b3c4d')).toBe(false)
  })

  test('SQLite has no id rewrite to do — its backfill was already random', () => {
    const sql = readFileSync(SQLITE_REGION_MIGRATION_PATH, 'utf-8')
    expect(sql).not.toMatch(/UPDATE "device_version_events"/)
    // The historical twin backfilled random ids, so there is no desktop data to
    // rewrite; the parity migration only changes the key.
    const historical = readFileSync(SQLITE_MIGRATION_PATH, 'utf-8')
    expect(historical).toContain(`'dve_' || lower(hex(randomblob(10)))`)
    expect(historical).not.toMatch(/md5\(/)
  })

  test('the original migration is left as history (unchanged id derivation)', () => {
    // Rewriting an applied migration changes the checksum Prisma recorded.
    const sql = readFileSync(PG_MIGRATION_PATH, 'utf-8')
    expect(sql).toContain(`'dve_' || md5(k."deviceId" || ':' || k."deviceAppVersion")`)
    expect(sql).toContain('CREATE UNIQUE INDEX "device_version_events_deviceId_version_key"')
  })
})

