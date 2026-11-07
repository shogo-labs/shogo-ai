// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `applyPublishedSchema` against a real Postgres with the repo's real Prisma CLI
 * (SHO-308 §1). The unit suite covers schema conversion and seed ordering; this
 * one covers the two CLI calls, which only fail when they actually run: a flag
 * Prisma 7 no longer accepts prints the command's help and exits 1, and running
 * from the project directory without `--config` would push to the app's own
 * SQLite file instead of the published database.
 *
 * Runs when CHANNELS_TEST_PG_URL points at a Postgres server whose user can
 * create databases (the `rbac-postgres` CI job sets it), and skips otherwise:
 *   CHANNELS_TEST_PG_URL=postgresql://shogo:shogo@127.0.0.1:5432/shogo \
 *     bun test src/__tests__/published-schema-apply.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { applyPublishedSchema } from '../published-schema-apply'

const SERVER_URL = process.env.CHANNELS_TEST_PG_URL
if (process.env.REQUIRE_PG_INTEGRATION === '1' && !SERVER_URL) {
  throw new Error('REQUIRE_PG_INTEGRATION=1 but CHANNELS_TEST_PG_URL is not set')
}

const REPO_NODE_MODULES = resolve(import.meta.dir, '../../../../node_modules')

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

const dbName = `shogo_pubschema_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
let admin: SQL | null = null
let published: SQL | null = null
let databaseUrl = ''
const dirs: string[] = []

/**
 * A workspace laid out like a real one: the app's schema, its dev.db, and its
 * own prisma.config.ts pointing at that SQLite file — the config a publish
 * must not pick up.
 */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-published-apply-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'prisma'), { recursive: true })
  symlinkSync(REPO_NODE_MODULES, join(dir, 'node_modules'), 'dir')
  writeFileSync(join(dir, 'prisma', 'schema.prisma'), SCHEMA)
  writeFileSync(
    join(dir, 'prisma.config.ts'),
    [
      `import { defineConfig } from 'prisma/config'`,
      `export default defineConfig({`,
      `  schema: 'prisma/schema.prisma',`,
      `  datasource: { url: 'file:./prisma/dev.db' },`,
      `})`,
      ``,
    ].join('\n'),
  )
  const db = new Database(join(dir, 'prisma', 'dev.db'))
  db.run('CREATE TABLE "User" (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT 1)')
  db.run('CREATE TABLE "Post" (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, authorId INTEGER NOT NULL)')
  db.run(`INSERT INTO "User" (id, email, active) VALUES (1, 'a@example.com', 1), (5, 'b@example.com', 0)`)
  db.run(`INSERT INTO "Post" (id, title, authorId) VALUES (3, 'hello', 1)`)
  db.close()
  return dir
}

describe.skipIf(!SERVER_URL)('applyPublishedSchema (real Postgres + Prisma CLI)', () => {
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

  it('pushes the schema and loads dev.db into the published database', async () => {
    const dir = workspace()

    const result = await applyPublishedSchema({ projectDir: dir, databaseUrl, seed: true })

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
    expect(result.seeded).toEqual({ tables: 2, rows: 3 })

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

    // The app's own SQLite file was read, never written to by the push.
    const devDb = new Database(join(dir, 'prisma', 'dev.db'), { readonly: true })
    const tables = devDb.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all()
    devDb.close()
    expect(tables.map((t: any) => t.name)).toEqual(['Post', 'User', 'sqlite_sequence'])
  }, 180_000)
})
