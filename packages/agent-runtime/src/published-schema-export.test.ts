// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The SQLite→Postgres switchover seed (SHO-514).
 *
 * A published environment that is already live on SQLite has real rows in its
 * published-data archive. The seed that crosses to Postgres has to come from
 * THAT database, not the builder's `prisma/dev.db` — seeding from the workspace
 * would hand Postgres the builder's sample rows and orphan every sign-up the
 * live site accumulated. Pinned here, because both databases look identical in
 * shape and the wrong one is silently plausible.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import * as tar from 'tar'
import { exportPublishedSchema } from './published-schema-export'

const SCHEMA = `datasource db {
  provider = "sqlite"
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`

const roots: string[] = []

/** A project dir with the schema and a `prisma/dev.db` holding `builder@example.com`. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-export-project-'))
  roots.push(dir)
  mkdirSync(join(dir, 'prisma'), { recursive: true })
  writeFileSync(join(dir, 'prisma', 'schema.prisma'), SCHEMA)
  seedDb(join(dir, 'prisma', 'dev.db'), 'builder@example.com')
  return dir
}

function seedDb(path: string, email: string): void {
  const db = new Database(path)
  try {
    db.exec('CREATE TABLE "User" (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE)')
    db.query('INSERT INTO "User" (email) VALUES (?)').run(email)
  } finally {
    db.close()
  }
}

/** The live environment's `prisma/` directory, as the base64 archive the API sends. */
async function makeLiveArchive(emails: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-export-live-'))
  roots.push(dir)
  mkdirSync(join(dir, 'prisma'), { recursive: true })
  const db = new Database(join(dir, 'prisma', 'dev.db'))
  try {
    db.exec('CREATE TABLE "User" (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE)')
    for (const email of emails) db.query('INSERT INTO "User" (email) VALUES (?)').run(email)
  } finally {
    db.close()
  }
  const archivePath = join(dir, 'seed.tar.gz')
  await tar.create({ gzip: true, file: archivePath, cwd: dir, portable: true }, ['prisma'])
  return (await Bun.file(archivePath).bytes()).toBase64()
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('exportPublishedSchema seed source', () => {
  it('seeds from the live archive, not the builder dev.db', async () => {
    const projectDir = makeProject()
    const seedArchive = await makeLiveArchive(['live-1@example.com', 'live-2@example.com'])

    const result = await exportPublishedSchema(projectDir, { seed: true, seedArchive })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.seedSource).toBe('archive')
    expect(result.seed?.rows).toBe(2)
    expect(result.seed?.sql).toContain('live-1@example.com')
    expect(result.seed?.sql).toContain('live-2@example.com')
    // The builder's row must not cross over: it is what the switchover exists to
    // stop shipping.
    expect(result.seed?.sql).not.toContain('builder@example.com')
  })

  it('seeds from the workspace dev.db when there is no archive to carry over', async () => {
    const projectDir = makeProject()

    const result = await exportPublishedSchema(projectDir, { seed: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.seedSource).toBe('workspace')
    expect(result.seed?.sql).toContain('builder@example.com')
  })

  it('refuses an archive with no database in it rather than seeding the workspace', async () => {
    const projectDir = makeProject()
    const empty = mkdtempSync(join(tmpdir(), 'shogo-export-empty-'))
    roots.push(empty)
    mkdirSync(join(empty, 'prisma'), { recursive: true })
    writeFileSync(join(empty, 'prisma', 'notes.txt'), 'no database here')
    const archivePath = join(empty, 'seed.tar.gz')
    await tar.create({ gzip: true, file: archivePath, cwd: empty, portable: true }, ['prisma'])
    const seedArchive = (await Bun.file(archivePath).bytes()).toBase64()

    const result = await exportPublishedSchema(projectDir, { seed: true, seedArchive })

    // Falling back to `dev.db` here would look like success while shipping the
    // builder's rows over a live site's data.
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('seed_archive_invalid')
  })

  it('does not read any database when no seed was asked for', async () => {
    const projectDir = makeProject()
    const result = await exportPublishedSchema(projectDir, { seed: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.seed).toBeNull()
    expect(result.seedSource).toBeUndefined()
  })
})
