// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The runtime half of Postgres at publish (SHO-308 §1): reading the app's schema
 * and turning `prisma/dev.db` into seed rows in an order Postgres accepts.
 *
 * The push itself needs a Prisma CLI and a live database, so it is exercised by
 * the staging deploy (docs/runbooks/published-postgres.md) rather than here —
 * what is unit-tested is the part that has to be right before any of that runs.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectSeedTables, exportPublishedSchema, resolvePublishSchema } from '../published-schema-export'

const dirs: string[] = []

function projectDir(files: { schema?: string; devDb?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-published-schema-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'prisma'), { recursive: true })
  if (files.schema !== undefined) writeFileSync(join(dir, 'prisma', 'schema.prisma'), files.schema)
  if (files.devDb) writeFileSync(join(dir, 'prisma', 'dev.db'), '')
  return dir
}

const SCHEMA = `datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}
`

afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // tmpdir cleanup is best-effort
    }
  }
})

describe('resolvePublishSchema', () => {
  it('converts the app schema to the Postgres one a publish pushes', () => {
    const resolved = resolvePublishSchema(projectDir({ schema: SCHEMA }))
    expect(resolved).not.toBeNull()
    expect(resolved!.content).toContain('provider = "postgresql"')
    expect(resolved!.transformed).toBe(true)
    expect(resolved!.hash).toMatch(/^[0-9a-f]{40}$/)
  })

  it('returns null for a project with no schema file', () => {
    expect(resolvePublishSchema(projectDir())).toBeNull()
  })

  it('returns null for a schema with no models (a static app)', () => {
    const headerOnly = SCHEMA.split('model User')[0]!
    expect(resolvePublishSchema(projectDir({ schema: headerOnly }))).toBeNull()
  })
})

describe('collectSeedTables', () => {
  it('reads every row, with referenced tables first and sequences flagged', async () => {
    const dir = projectDir({ schema: SCHEMA, devDb: true })
    const db = new Database(join(dir, 'prisma', 'dev.db'))
    db.run('CREATE TABLE "User" (id INTEGER PRIMARY KEY, email TEXT)')
    db.run('CREATE TABLE "Post" (id INTEGER PRIMARY KEY, title TEXT, authorId INTEGER)')
    db.run(`INSERT INTO "User" (id, email) VALUES (1, 'a@example.com'), (2, 'b@example.com')`)
    db.run(`INSERT INTO "Post" (id, title, authorId) VALUES (7, 'hello', 1)`)
    db.close()

    const tables = await collectSeedTables(dir, resolvePublishSchema(dir)!.content)

    // Users before posts: the FK points that way.
    expect(tables.map((table) => table.table)).toEqual(['User', 'Post'])
    expect(tables[0]!.rows).toHaveLength(2)
    expect(tables[1]!.rows).toEqual([[7, 'hello', 1]])
    expect(tables[0]!.serialIdColumn).toBe('id')
  })

  it('seeds nothing when the workspace has no dev.db yet', async () => {
    const dir = projectDir({ schema: SCHEMA })
    expect(await collectSeedTables(dir, resolvePublishSchema(dir)!.content)).toEqual([])
  })
})

describe('exportPublishedSchema', () => {
  function seededDir(): string {
    const dir = projectDir({ schema: SCHEMA, devDb: true })
    const db = new Database(join(dir, 'prisma', 'dev.db'))
    db.run('CREATE TABLE "User" (id INTEGER PRIMARY KEY, email TEXT)')
    db.run('CREATE TABLE "Post" (id INTEGER PRIMARY KEY, title TEXT, authorId INTEGER)')
    db.run(`INSERT INTO "User" (id, email) VALUES (1, 'a@example.com')`)
    db.run(`INSERT INTO "Post" (id, title, authorId) VALUES (7, 'it''s', 1)`)
    db.close()
    return dir
  }

  it('returns the Postgres schema and dev.db as seed SQL, users before posts', async () => {
    const result = await exportPublishedSchema(seededDir(), { seed: true })
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
    expect(result.schema.content).toContain('provider = "postgresql"')
    expect(result.seed).toMatchObject({ tables: 2, rows: 2 })
    const sql = result.seed!.sql
    expect(sql.indexOf('INSERT INTO "User"')).toBeLessThan(sql.indexOf('INSERT INTO "Post"'))
    expect(sql).toContain("'it''s'")
  })

  it('exports no seed when none is asked for', async () => {
    const result = await exportPublishedSchema(seededDir())
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
    expect(result.seed).toBeNull()
  })

  it('exports no seed when dev.db has no rows', async () => {
    const result = await exportPublishedSchema(projectDir({ schema: SCHEMA }), { seed: true })
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
    expect(result.seed).toBeNull()
  })

  it('refuses an app with no models as no_schema', async () => {
    const result = await exportPublishedSchema(projectDir())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('no_schema')
  })
})
