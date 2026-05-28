// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `runtime-checks.ts` schema-parsing tests.
 *
 * Locks in the contract that `parseModels` correctly identifies foreign-key
 * scalar fields (those backing a `@relation(fields: [...])`) and excludes
 * them from the synthetic POST body, while flagging the model as
 * `requiresForeignKey` so the create-probe is skipped. Without this, the
 * eval runtime check sends `"eval-test-departmentId"` for a `Hire`'s
 * `departmentId String`, Prisma rejects with a FK constraint, and the
 * eval reports a confusing "POST /api/hires" error that has nothing to
 * do with the route's correctness.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseModels, buildTestBody } from './runtime-checks'

const tmpDirs: string[] = []

function makeSchema(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-checks-test-'))
  tmpDirs.push(dir)
  mkdirSync(join(dir, 'prisma'), { recursive: true })
  const schemaPath = join(dir, 'prisma', 'schema.prisma')
  writeFileSync(schemaPath, content)
  return schemaPath
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

describe('parseModels', () => {
  test('skips FK scalars and flags the model as requiresForeignKey', () => {
    const schema = makeSchema(`
model Department {
  id    String @id @default(uuid())
  name  String
}

model Hire {
  id           String     @id @default(uuid())
  name         String
  role         String
  departmentId String
  department   Department @relation(fields: [departmentId], references: [id])
}
`)
    const models = parseModels(schema)
    const hire = models.find(m => m.name === 'Hire')!
    expect(hire).toBeDefined()
    // Required scalars: name, role. NOT departmentId (FK).
    expect(hire.requiredFields.map(f => f.name).sort()).toEqual(['name', 'role'])
    expect(hire.requiresForeignKey).toBe(true)
  })

  test('handles multi-field foreign keys', () => {
    const schema = makeSchema(`
model Tenant {
  id   String @id @default(uuid())
  shard String
  name String

  @@unique([id, shard])
}

model Member {
  id          String @id @default(uuid())
  email       String
  tenantId    String
  tenantShard String
  tenant      Tenant @relation(fields: [tenantId, tenantShard], references: [id, shard])
}
`)
    const models = parseModels(schema)
    const member = models.find(m => m.name === 'Member')!
    expect(member.requiredFields.map(f => f.name).sort()).toEqual(['email'])
    expect(member.requiresForeignKey).toBe(true)
  })

  test('does NOT flag plain models without relations', () => {
    const schema = makeSchema(`
model Note {
  id    String @id @default(uuid())
  title String
  body  String
}
`)
    const models = parseModels(schema)
    const note = models.find(m => m.name === 'Note')!
    expect(note.requiresForeignKey).toBe(false)
    expect(note.requiredFields.map(f => f.name).sort()).toEqual(['body', 'title'])
  })

  test('still excludes id-with-default and @updatedAt fields', () => {
    const schema = makeSchema(`
model Post {
  id        String   @id @default(uuid())
  title     String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
`)
    const models = parseModels(schema)
    const post = models.find(m => m.name === 'Post')!
    expect(post.requiredFields.map(f => f.name)).toEqual(['title'])
    expect(post.requiresForeignKey).toBe(false)
  })
})

describe('buildTestBody', () => {
  test('builds a body with one entry per declared scalar field', () => {
    const schema = makeSchema(`
model Hire {
  id   String @id @default(uuid())
  name String
  role String
  rank Int
}
`)
    const hire = parseModels(schema).find(m => m.name === 'Hire')!
    const body = buildTestBody(hire)
    expect(body).toEqual({
      name: 'eval-test-name',
      role: 'eval-test-role',
      rank: 1,
    })
  })

  test('produces a body without FK scalars (which would fail constraint)', () => {
    const schema = makeSchema(`
model Department {
  id String @id @default(uuid())
}

model Hire {
  id           String     @id @default(uuid())
  name         String
  departmentId String
  department   Department @relation(fields: [departmentId], references: [id])
}
`)
    const hire = parseModels(schema).find(m => m.name === 'Hire')!
    const body = buildTestBody(hire)
    expect(body).toEqual({ name: 'eval-test-name' })
    expect(body.departmentId).toBeUndefined()
  })
})
