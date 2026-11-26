// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-551 B: a Postgres build context must ship @prisma/adapter-pg in db.tsx,
// not @prisma/adapter-libsql. The wrong driver was what caused every published
// Postgres query to fail: the driver was baked into the image at build time, and
// the SQLite driver cannot talk to projects-pg.

import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyPostgresBuildContext, dropSqliteDatabaseFiles } from '../published-build-db'

function makeContext(
  opts: { dbTs?: string; dbTsx?: string; packageJson?: object; schema?: string } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-build-ctx-'))
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
  if (opts.dbTs !== undefined) {
    writeFileSync(join(dir, 'src', 'lib', 'db.ts'), opts.dbTs, 'utf-8')
  }
  if (opts.dbTsx !== undefined) {
    writeFileSync(join(dir, 'src', 'lib', 'db.tsx'), opts.dbTsx, 'utf-8')
  }
  if (opts.packageJson !== undefined) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(opts.packageJson, null, 2), 'utf-8')
  }
  if (opts.schema !== undefined) {
    mkdirSync(join(dir, 'prisma'), { recursive: true })
    writeFileSync(join(dir, 'prisma', 'schema.prisma'), opts.schema, 'utf-8')
  }
  return dir
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SQLITE_DB_TSX = `import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '../generated/prisma/client'

const adapter = new PrismaLibSql({ url: process.env.DATABASE_URL ?? 'file:./prisma/dev.db' })
export const prisma = new PrismaClient({ adapter })
`

const SQLITE_SCHEMA = `datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

model Todo {
  id    String @id
  title String
}
`

const POSTGRES_DB_TSX = `import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
export const prisma = new PrismaClient({ adapter })
`

describe('applyPostgresBuildContext', () => {
  it('rewrites a SQLite db.tsx to use the Postgres adapter', () => {
    const dir = makeContext({ dbTsx: SQLITE_DB_TSX })
    dirs.push(dir)
    const result = applyPostgresBuildContext(dir)
    expect(result.applied).toBe(true)
    const written = readFileSync(join(dir, 'src', 'lib', 'db.tsx'), 'utf-8')
    expect(written).toContain('@prisma/adapter-pg')
    expect(written).not.toContain('@prisma/adapter-libsql')
    // AC 3: the client refuses to boot against a mismatched URL.
    expect(written).toContain('process.exit(1)')
  })

  it('converts the schema in the build context and leaves the source alone', () => {
    const schema = `datasource db {\n  provider = "sqlite"\n}\n\ngenerator client {\n  provider = "prisma-client"\n  output   = "../src/generated/prisma"\n}\n\nmodel Todo {\n  id    String @id\n  title String\n}\n`
    const dir = makeContext({ dbTsx: SQLITE_DB_TSX, schema })
    dirs.push(dir)
    const result = applyPostgresBuildContext(dir)
    expect(result.applied).toBe(true)
    const written = readFileSync(join(dir, 'prisma', 'schema.prisma'), 'utf-8')
    expect(written).toContain('provider = "postgresql"')
    expect(written).not.toContain('provider = "sqlite"')
  })

  it('promotes a dev-only Postgres package into dependencies', () => {
    const dir = makeContext({
      dbTsx: SQLITE_DB_TSX,
      packageJson: {
        name: 'my-app',
        dependencies: {},
        devDependencies: { '@prisma/adapter-pg': '^1.0.0' },
      },
    })
    dirs.push(dir)
    applyPostgresBuildContext(dir)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
    expect(pkg.dependencies['@prisma/adapter-pg']).toBe('^1.0.0')
    expect(pkg.devDependencies?.['@prisma/adapter-pg']).toBeUndefined()
  })

  // QA round 1: the image installs with `bun install --production` and
  // `@prisma/adapter-pg` is only an optional peer of the SDK, so a package.json
  // that never mentions the adapter produced an image that booted into
  // `Cannot find module '@prisma/adapter-pg'`.
  it('adds both adapter packages when package.json lists neither', () => {
    const dir = makeContext({
      dbTsx: SQLITE_DB_TSX,
      packageJson: { name: 'my-app', dependencies: { '@shogo-ai/sdk': '^1.0.0' } },
    })
    dirs.push(dir)
    applyPostgresBuildContext(dir)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
    expect(pkg.dependencies['@prisma/adapter-pg']).toBeTruthy()
    expect(pkg.dependencies['pg']).toBeTruthy()
  })

  it('is idempotent when the context is already Postgres', () => {
    const schema = `datasource db {\n  provider = "postgresql"\n}\n\ngenerator client {\n  provider = "prisma-client"\n  output   = "../src/generated/prisma"\n}\n\nmodel Todo {\n  id    String @id\n  title String\n}\n`
    const dir = makeContext({
      dbTsx: POSTGRES_DB_TSX,
      schema,
      packageJson: { name: 'my-app', dependencies: { '@prisma/adapter-pg': '^7.0.0', pg: '^8.16.3' } },
    })
    dirs.push(dir)
    const before = readFileSync(join(dir, 'package.json'), 'utf-8')
    const result = applyPostgresBuildContext(dir)
    expect(result.applied).toBe(false)
    expect(readFileSync(join(dir, 'src', 'lib', 'db.tsx'), 'utf-8')).toBe(POSTGRES_DB_TSX)
    expect(readFileSync(join(dir, 'package.json'), 'utf-8')).toBe(before)
  })

  // QA round 5: this used to warn and carry on. A context with no db module
  // ships the app's own SQLite client to a Postgres database, which on staging
  // wrote to a per-pod LibSQL file and lost every cross-pod read.
  it('refuses a context with no db module instead of warning', () => {
    const dir = makeContext({ schema: SQLITE_SCHEMA }) // no db.ts / db.tsx
    dirs.push(dir)
    const result = applyPostgresBuildContext(dir)
    expect(result.ok).toBe(false)
    expect(result.dbModule).toBeNull()
    expect(result.errors.some((e) => e.includes('No src/lib/db.ts'))).toBe(true)
  })

  it('refuses a context whose schema could not be converted to Postgres', () => {
    const dir = makeContext({ dbTs: SQLITE_DB_TSX }) // no prisma/schema.prisma
    dirs.push(dir)
    const result = applyPostgresBuildContext(dir)
    expect(result.ok).toBe(false)
    expect(result.schemaProvider).toBeNull()
    expect(result.errors.some((e) => e.includes('prisma/schema.prisma is missing'))).toBe(true)
  })

  // The runtime template writes `src/lib/db.ts`; only older projects have
  // `db.tsx`. Looking for `db.tsx` alone left every current project on
  // `PrismaLibSql` — the client QA found inside the Postgres pod.
  it('rewrites the current template db module, src/lib/db.ts', () => {
    const dir = makeContext({ dbTs: SQLITE_DB_TSX, schema: SQLITE_SCHEMA, packageJson: { name: 'my-app' } })
    dirs.push(dir)
    const result = applyPostgresBuildContext(dir)
    expect(result.ok).toBe(true)
    expect(result.applied).toBe(true)
    expect(result.dbModule).toBe('src/lib/db.ts')
    expect(result.schemaProvider).toBe('postgresql')
    const written = readFileSync(join(dir, 'src', 'lib', 'db.ts'), 'utf-8')
    expect(written).toContain('@prisma/adapter-pg')
    expect(written).not.toContain('@prisma/adapter-libsql')
  })

  it('prefers db.ts and leaves a stray db.tsx alone', () => {
    const dir = makeContext({ dbTs: SQLITE_DB_TSX, dbTsx: SQLITE_DB_TSX, schema: SQLITE_SCHEMA })
    dirs.push(dir)
    const result = applyPostgresBuildContext(dir)
    expect(result.dbModule).toBe('src/lib/db.ts')
    expect(readFileSync(join(dir, 'src', 'lib', 'db.ts'), 'utf-8')).toContain('@prisma/adapter-pg')
  })
})

describe('dropSqliteDatabaseFiles', () => {
  it('removes the builder database and its WAL, and reports what went', () => {
    const dir = makeContext({ dbTs: SQLITE_DB_TSX, schema: SQLITE_SCHEMA })
    dirs.push(dir)
    writeFileSync(join(dir, 'prisma', 'dev.db'), 'x'.repeat(64))
    writeFileSync(join(dir, 'prisma', 'dev.db-wal'), 'w')
    writeFileSync(join(dir, 'prisma', 'dev.db-shm'), 's')

    const removed = dropSqliteDatabaseFiles(dir)

    expect(removed.sort()).toEqual(['prisma/dev.db', 'prisma/dev.db-shm', 'prisma/dev.db-wal'])
    expect(existsSync(join(dir, 'prisma', 'dev.db'))).toBe(false)
    expect(existsSync(join(dir, 'prisma', 'dev.db-wal'))).toBe(false)
    // The schema and the source must survive: the image is built from them.
    expect(existsSync(join(dir, 'prisma', 'schema.prisma'))).toBe(true)
  })

  it('is a no-op when the context has no SQLite database', () => {
    const dir = makeContext({ dbTs: SQLITE_DB_TSX, schema: SQLITE_SCHEMA })
    dirs.push(dir)
    expect(dropSqliteDatabaseFiles(dir)).toEqual([])
  })
})
