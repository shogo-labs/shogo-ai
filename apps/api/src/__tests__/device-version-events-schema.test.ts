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

const PG_SCHEMA = readFileSync(resolve(REPO_ROOT, 'prisma/schema.prisma'), 'utf-8')
const LOCAL_SCHEMA = readFileSync(resolve(REPO_ROOT, 'prisma/schema.local.prisma'), 'utf-8')
const PG_MIGRATION_PATH = resolve(REPO_ROOT, `prisma/migrations/${MIGRATION_ID}/migration.sql`)
const SQLITE_MIGRATION_PATH = resolve(REPO_ROOT, `apps/desktop/prisma/migrations/${MIGRATION_ID}/migration.sql`)

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

  test('keeps one row per (device, version) and indexes the analytics reads', () => {
    for (const schema of [PG_SCHEMA, LOCAL_SCHEMA]) {
      const block = modelBlock(schema, 'DeviceVersionEvent')
      expect(block).toContain('@@unique([deviceId, version])')
      expect(block).toContain('@@index([lastSeenAt])')
      expect(block).toContain('@@index([version])')
      expect(block).toContain('@@map("device_version_events")')
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
