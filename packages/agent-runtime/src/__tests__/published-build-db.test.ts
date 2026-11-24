// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-551 B: a Postgres build context must ship @prisma/adapter-pg in db.tsx,
// not @prisma/adapter-libsql. The wrong driver was what caused every published
// Postgres query to fail: the driver was baked into the image at build time, and
// the SQLite driver cannot talk to projects-pg.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyPostgresBuildContext } from '../published-build-db'

function makeContext(opts: { dbTsx?: string; packageJson?: object } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-build-ctx-'))
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
  if (opts.dbTsx !== undefined) {
    writeFileSync(join(dir, 'src', 'lib', 'db.tsx'), opts.dbTsx, 'utf-8')
  }
  if (opts.packageJson !== undefined) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(opts.packageJson, null, 2), 'utf-8')
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
    expect(result.warnings).toHaveLength(0)
    const written = readFileSync(join(dir, 'src', 'lib', 'db.tsx'), 'utf-8')
    expect(written).toContain('@prisma/adapter-pg')
    expect(written).not.toContain('@prisma/adapter-libsql')
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

  it('is idempotent when db.tsx already uses the Postgres adapter', () => {
    const dir = makeContext({ dbTsx: POSTGRES_DB_TSX })
    dirs.push(dir)
    const result = applyPostgresBuildContext(dir)
    expect(result.applied).toBe(false)
    // File unchanged
    expect(readFileSync(join(dir, 'src', 'lib', 'db.tsx'), 'utf-8')).toBe(POSTGRES_DB_TSX)
  })

  it('warns instead of inventing a schema for an app that has none', () => {
    const dir = makeContext({}) // no db.tsx
    dirs.push(dir)
    const result = applyPostgresBuildContext(dir)
    expect(result.applied).toBe(false)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain('src/lib/db.tsx not found')
  })
})
