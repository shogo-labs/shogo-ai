// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The publish-time schema push, end to end against a real Postgres with the
 * API's real Prisma CLI (SHO-308 §1): the runtime's export of a workspace
 * (schema + dev.db as seed SQL) is pushed by the API, the way a publish does it.
 *
 * Covers what only fails when the CLI really runs: a flag Prisma 7 no longer
 * accepts prints the command's help and exits 1, and a push that picked up any
 * config other than its own would land somewhere other than the database it was
 * given.
 *
 * Runs when CHANNELS_TEST_PG_URL points at a Postgres server whose user can
 * create databases (the `rbac-postgres` CI job sets it), and skips otherwise:
 *   CHANNELS_TEST_PG_URL=postgresql://shogo:shogo@127.0.0.1:5432/shogo \
 *     bun test src/services/__tests__/published-schema-push.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { exportPublishedSchema } from '@shogo/agent-runtime/src/published-schema-export'
import { pushPublishedSchema } from '../published-schema-push'

const SERVER_URL = process.env.CHANNELS_TEST_PG_URL
if (process.env.REQUIRE_PG_INTEGRATION === '1' && !SERVER_URL) {
  throw new Error('REQUIRE_PG_INTEGRATION=1 but CHANNELS_TEST_PG_URL is not set')
}

const SCHEMA = `datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

model User {
  id     Int     @id @default(autoincrement())
  email  String  @unique
  active Boolean @default(true)
  posts  Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}
`

const dbName = `shogo_pubpush_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
let admin: SQL | null = null
let published: SQL | null = null
let databaseUrl = ''
const dirs: string[] = []

/** A workspace laid out like a real one: the app's schema and its dev.db. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-published-push-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'prisma'), { recursive: true })
  writeFileSync(join(dir, 'prisma', 'schema.prisma'), SCHEMA)
  const db = new Database(join(dir, 'prisma', 'dev.db'))
  db.run('CREATE TABLE "User" (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT 1)')
  db.run('CREATE TABLE "Post" (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, authorId INTEGER NOT NULL)')
  db.run(`INSERT INTO "User" (id, email, active) VALUES (1, 'a@example.com', 1), (5, 'b@example.com', 0)`)
  db.run(`INSERT INTO "Post" (id, title, authorId) VALUES (3, 'hello', 1)`)
  db.close()
  return dir
}

describe.skipIf(!SERVER_URL)('pushPublishedSchema (real Postgres + Prisma CLI)', () => {
  beforeAll(async () => {
    admin = new SQL(SERVER_URL!)
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    const url = new URL(SERVER_URL!)
    url.pathname = `/${dbName}`
    databaseUrl = url.toString()
    published = new SQL(databaseUrl)
  })

  afterAll(async () => {
    await published?.close()
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
      await admin.close()
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('pushes the exported schema and loads dev.db into the published database', async () => {
    const exported = await exportPublishedSchema(workspace(), { seed: true })
    if (!exported.ok) throw new Error(`${exported.code}: ${exported.message}`)
    expect(exported.seed).toMatchObject({ tables: 2, rows: 3 })

    const result = await pushPublishedSchema({
      schema: exported.schema.content,
      seedSql: exported.seed!.sql,
      databaseUrl,
    })
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`)

    const users = await published!`SELECT id, email, active FROM "User" ORDER BY id`
    expect(users.map((u: any) => [u.id, u.email, u.active])).toEqual([
      [1, 'a@example.com', true],
      [5, 'b@example.com', false],
    ])
    const posts = await published!`SELECT id, title, "authorId" FROM "Post"`
    expect(posts.map((p: any) => [p.id, p.title, p.authorId])).toEqual([[3, 'hello', 1]])

    // The sequence continues past the seeded ids, so the live app's first
    // insert does not collide with a row copied from dev.db.
    const [next] = await published!`INSERT INTO "User" (email) VALUES ('c@example.com') RETURNING id`
    expect(next.id).toBe(6)
  }, 180_000)

  it('republishes the same schema without touching the rows (no seed)', async () => {
    const exported = await exportPublishedSchema(workspace(), { seed: false })
    if (!exported.ok) throw new Error(`${exported.code}: ${exported.message}`)
    expect(exported.seed).toBeNull()

    const result = await pushPublishedSchema({ schema: exported.schema.content, seedSql: null, databaseUrl })
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`)

    const [{ count }] = await published!`SELECT count(*)::int AS count FROM "User"`
    expect(count).toBe(3)
  }, 180_000)

  it('reports a database it cannot reach as schema_push_failed', async () => {
    const exported = await exportPublishedSchema(workspace())
    if (!exported.ok) throw new Error(`${exported.code}: ${exported.message}`)
    const unreachable = new URL(databaseUrl)
    unreachable.port = '1'
    const result = await pushPublishedSchema({
      schema: exported.schema.content,
      seedSql: null,
      databaseUrl: unreachable.toString(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('schema_push_failed')
  }, 180_000)
})
