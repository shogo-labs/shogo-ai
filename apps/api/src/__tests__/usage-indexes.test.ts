// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-140 acceptance 8 — the composite index exists on *both* tracks.
 *
 * `check:desktop-schema-drift` compares the SQLite migration tree to
 * `schema.local.prisma`, and `EXPLAIN` in the perf test proves the index is
 * used — but neither can see that `schema.prisma` (cloud) declares the same
 * pair. This is that parity guard: desktop and cloud never diverge.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')

function usageEventBlock(schemaPath: string): string {
  const schema = readFileSync(resolve(REPO_ROOT, schemaPath), 'utf-8')
  const match = schema.match(/model UsageEvent \{([\s\S]*?)\n\}/)
  if (!match) throw new Error(`model UsageEvent not found in ${schemaPath}`)
  return match[1]
}

const TRACKS = [
  { name: 'cloud', schema: 'prisma/schema.prisma', migrations: 'prisma/migrations' },
  { name: 'desktop', schema: 'prisma/schema.local.prisma', migrations: 'apps/desktop/prisma/migrations' },
]

describe.each(TRACKS)('$name usage_events indexes', ({ schema }) => {
  test(`${schema} declares the composite indexes`, () => {
    const block = usageEventBlock(schema)
    expect(block).toContain('@@index([workspaceId, createdAt])')
    expect(block).toContain('@@index([projectId, createdAt])')
  })

  test(`the single-column indexes stay`, () => {
    const block = usageEventBlock(schema)
    // The single-column indexes stay: other queries still use them.
    expect(block).toContain('@@index([workspaceId])')
    expect(block).toContain('@@index([memberId])')
    expect(block).toContain('@@index([createdAt])')
  })
})

describe('the usage_events indexes exist in both migration tracks', () => {
  for (const { name, migrations } of TRACKS) {
    test(`${name} migration creates both composite indexes`, () => {
      const sql = readFileSync(
        resolve(REPO_ROOT, migrations, '20261022025734_add_usage_event_composite_indexes', 'migration.sql'),
        'utf-8',
      )
      expect(sql).toContain('usage_events_workspaceId_createdAt_idx')
      expect(sql).toContain('usage_events_projectId_createdAt_idx')
      expect(sql).toContain('"usage_events"("workspaceId", "createdAt")')
      expect(sql).toContain('"usage_events"("projectId", "createdAt")')
      // Plan's rollout note: the cloud migration must be a no-op where the
      // index was already built CONCURRENTLY out of band.
      if (name === 'cloud') expect(sql).toContain('IF NOT EXISTS')
    })
  }
})
