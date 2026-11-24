// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Apply the database build context to a project before it is tarred into the
 * per-commit image (SHO-551 §B).
 *
 * A Postgres publish needs a different `src/lib/db.tsx` from a SQLite one:
 * the SQLite runtime template ships `@prisma/adapter-libsql`, but the
 * published pod connects to `projects-pg` via `@prisma/adapter-pg`. Silently
 * shipping the wrong driver makes every query fail with a driver mismatch.
 *
 * The context is applied before the artifact tar is built, so the image the
 * BuildKit Job produces has the right driver baked in. The rewrite is scoped
 * to the publish staging area (`dist.publish.staging`) so the workspace's own
 * `src/lib/db.tsx` is never touched.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ApplyPostgresBuildContextResult {
  applied: boolean
  warnings: string[]
}

/**
 * Rewrite `src/lib/db.tsx` in `contextDir` to use the Postgres adapter, and
 * move `@prisma/adapter-pg` from devDependencies to dependencies in
 * `package.json` so it is installed in the image.
 *
 * Both edits are idempotent: a file that already imports `@prisma/adapter-pg`
 * is left unchanged.
 *
 * @param contextDir — the publish staging directory (a copy of the workspace)
 */
export function applyPostgresBuildContext(contextDir: string): ApplyPostgresBuildContextResult {
  const warnings: string[] = []
  const dbPath = join(contextDir, 'src', 'lib', 'db.tsx')

  if (!existsSync(dbPath)) {
    warnings.push(
      `src/lib/db.tsx not found in the build context — the image will not have a Postgres db client. ` +
        `Create src/lib/db.tsx that imports PrismaPg and re-publish.`,
    )
    return { applied: false, warnings }
  }

  const existing = readFileSync(dbPath, 'utf-8')
  if (existing.includes('@prisma/adapter-pg')) {
    // Already uses the Postgres adapter — nothing to do.
    return { applied: false, warnings }
  }

  // Check whether the file imports from generated prisma client so we can keep
  // the same import path after the rewrite.
  const clientImport = existing.includes("from '../generated/prisma/client'")
    ? `'../generated/prisma/client'`
    : existing.includes("from './generated/prisma/client'")
      ? `'./generated/prisma/client'`
      : `'../generated/prisma/client'`

  const POSTGRES_DB_TSX = [
    `import { PrismaPg } from '@prisma/adapter-pg'`,
    `import { PrismaClient } from ${clientImport}`,
    ``,
    `const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }`,
    ``,
    `const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })`,
    ``,
    `export const prisma =`,
    `  globalForPrisma.prisma ??`,
    `  new PrismaClient({`,
    `    adapter,`,
    `    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],`,
    `  })`,
    ``,
    `if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma`,
    ``,
  ].join('\n')

  writeFileSync(dbPath, POSTGRES_DB_TSX, 'utf-8')

  // Promote @prisma/adapter-pg to runtime dependencies so bun install in the
  // Dockerfile picks it up. Without this the pod boots with an unresolved import.
  const pkgPath = join(contextDir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const inDev = pkg.devDependencies?.['@prisma/adapter-pg']
      const inDeps = pkg.dependencies?.['@prisma/adapter-pg']
      if (inDev && !inDeps) {
        pkg.dependencies = pkg.dependencies ?? {}
        pkg.dependencies['@prisma/adapter-pg'] = inDev
        delete pkg.devDependencies['@prisma/adapter-pg']
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
      }
    } catch (err: any) {
      warnings.push(`Could not promote @prisma/adapter-pg to dependencies: ${err?.message ?? err}`)
    }
  }

  return { applied: true, warnings }
}
