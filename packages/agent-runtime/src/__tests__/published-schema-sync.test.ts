// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-551 D: schema identity check — a published Postgres pod must not re-push
// its schema on every boot, but must push when it has changed.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureAdditiveSchema, schemaIdentity } from '../published-schema-sync'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeProject(schema: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-sync-'))
  dirs.push(dir)
  const prismaDir = join(dir, 'prisma')
  require('fs').mkdirSync(prismaDir, { recursive: true })
  writeFileSync(join(prismaDir, 'schema.prisma'), schema, 'utf-8')
  return dir
}

const SCHEMA = `datasource db { provider = "postgresql" }
model User { id Int @id }`

describe('schemaIdentity', () => {
  it('returns the same hash when only whitespace or comments change', () => {
    const a = schemaIdentity(SCHEMA)
    const b = schemaIdentity(SCHEMA.replace(/\n/g, '\r\n'))
    const c = schemaIdentity('// top comment\n' + SCHEMA + '\n// trailing')
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it('returns a different hash when a field is added', () => {
    const a = schemaIdentity(SCHEMA)
    const b = schemaIdentity(SCHEMA + '\nmodel Post { id Int @id }')
    expect(a).not.toBe(b)
  })
})

describe('ensureAdditiveSchema', () => {
  it('skips the push when the schema has not changed since the last boot', async () => {
    const dir = makeProject(SCHEMA)
    const hash = schemaIdentity(SCHEMA)
    let pushCalled = 0
    const result = await ensureAdditiveSchema(
      dir,
      'postgres://localhost/test',
      { appliedHash: hash },
      { runDbPush: async () => { pushCalled++ } },
    )
    expect(result.status).toBe('unchanged')
    expect(result.timings.dbPush).toBe(0)
    expect(pushCalled).toBe(0)
  })

  it('pushes the schema when no state exists (first boot)', async () => {
    const dir = makeProject(SCHEMA)
    let pushCalled = 0
    const result = await ensureAdditiveSchema(
      dir,
      'postgres://localhost/test',
      null,
      { runDbPush: async () => { pushCalled++ } },
    )
    expect(result.status).toBe('applied')
    expect(pushCalled).toBe(1)
  })

  it('pushes when the hash has changed', async () => {
    const dir = makeProject(SCHEMA)
    let pushCalled = 0
    const result = await ensureAdditiveSchema(
      dir,
      'postgres://localhost/test',
      { appliedHash: 'old-hash' },
      { runDbPush: async () => { pushCalled++ } },
    )
    expect(result.status).toBe('applied')
    expect(pushCalled).toBe(1)
  })

  it('reports a failure without throwing', async () => {
    const dir = makeProject(SCHEMA)
    const result = await ensureAdditiveSchema(
      dir,
      'postgres://localhost/test',
      null,
      { runDbPush: async () => { throw new Error('connection refused') } },
    )
    expect(result.status).toBe('failed')
    expect(result.error).toContain('connection refused')
  })

  it('returns unchanged when there is no schema file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-nosync-'))
    dirs.push(dir)
    let pushCalled = 0
    const result = await ensureAdditiveSchema(
      dir,
      'postgres://localhost/test',
      null,
      { runDbPush: async () => { pushCalled++ } },
    )
    expect(result.status).toBe('unchanged')
    expect(pushCalled).toBe(0)
  })
})
