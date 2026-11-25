// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Apply the database build context to a project before it is tarred into the
 * per-commit image (SHO-551 §B).
 *
 * A Postgres publish needs three things that a SQLite publish does not, and all
 * three are baked in at image-build time, so they have to be written into the
 * staging copy before the tar is built:
 *
 *   1. `prisma/schema.prisma` with `provider = "postgresql"`, so the image's
 *      `prisma generate` produces a Postgres client;
 *   2. `src/lib/db.tsx` on `@prisma/adapter-pg` rather than the SQLite driver;
 *   3. `@prisma/adapter-pg` and `pg` in `dependencies`, because the Dockerfile
 *      installs with `bun install --production`.
 *
 * Those three used to be spread over two call sites — one of which never ran and
 * neither of which added the dependencies — so a Postgres image booted into
 * `Cannot find module '@prisma/adapter-pg'` (SHO-551, QA round 1). They live
 * here now, and the publish path calls this and nothing else.
 *
 * The rewrite is scoped to the publish staging area (`dist.publish.staging`), so
 * the workspace's own `src/lib/db.tsx` and `prisma/schema.prisma` are untouched.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateDbModule } from '@shogo-ai/sdk/generators'
import { buildPublishSchema } from '@shogo/shared-runtime/published-schema'

export interface ApplyPostgresBuildContextResult {
  /**
   * False when the context cannot be made Postgres at all: no schema, a schema
   * that will not convert, or no db module to rewrite. The caller must fail the
   * publish instead of tarring it — a pod with a SQLite `db.ts` and a Postgres
   * `DATABASE_URL` writes to a per-pod LibSQL file and loses every row on the
   * next request that lands elsewhere (SHO-551, QA round 5 on staging).
   */
  ok: boolean
  applied: boolean
  /** The db module that was found (and rewritten when it was a SQLite one). */
  dbModule: 'src/lib/db.ts' | 'src/lib/db.tsx' | null
  /** The datasource provider the context ends up with. */
  schemaProvider: 'postgresql' | 'sqlite' | null
  /** Reasons the context is unusable. Any entry means `ok: false`. */
  errors: string[]
  warnings: string[]
}

/**
 * Versions used only when the app's `package.json` mentions neither package.
 * A version the app (or the template) already pins always wins, because the
 * adapter tracks the Prisma client's own major.
 */
const FALLBACK_ADAPTER_VERSION = '^7.0.0'
const FALLBACK_PG_VERSION = '^8.16.3'

/** Packages a Postgres-published image must install at runtime. */
const REQUIRED_RUNTIME_PACKAGES = ['@prisma/adapter-pg', 'pg'] as const

/**
 * Rewrite the build context for Postgres: converted schema, Postgres `db.tsx`,
 * and the adapter packages in `dependencies`.
 *
 * Every edit is idempotent — a context that is already Postgres is left alone.
 *
 * @param contextDir — the publish staging directory (a copy of the workspace)
 */
export function applyPostgresBuildContext(contextDir: string): ApplyPostgresBuildContextResult {
  const warnings: string[] = []
  const errors: string[] = []
  let applied = false
  let dbModule: ApplyPostgresBuildContextResult['dbModule'] = null
  let schemaProvider: ApplyPostgresBuildContextResult['schemaProvider'] = null
  const result = (): ApplyPostgresBuildContextResult => ({
    ok: errors.length === 0,
    applied,
    dbModule,
    schemaProvider,
    errors,
    warnings,
  })

  // 1. The converted schema. The editor's own schema is a SQLite one; the image
  // must not generate a SQLite client (the pod talks to projects-pg).
  const schemaPath = join(contextDir, 'prisma', 'schema.prisma')
  if (!existsSync(schemaPath)) {
    errors.push(
      'prisma/schema.prisma is missing from the build context, so the image cannot generate a Postgres client.',
    )
  } else {
    try {
      const raw = readFileSync(schemaPath, 'utf-8')
      const published = buildPublishSchema(raw)
      if (published.transformed) {
        writeFileSync(schemaPath, published.content, 'utf-8')
        applied = true
        for (const warning of published.warnings) warnings.push(warning)
      }
      // Read the provider back out of the file the image will generate from.
      // "transformed" only says the helper ran; a schema it could not convert
      // (or one already left on sqlite) is what shipped a LibSQL client into a
      // Postgres pod on staging (SHO-551, QA round 5).
      const reread = buildPublishSchema(readFileSync(schemaPath, 'utf-8'))
      schemaProvider = reread.transformed ? 'sqlite' : 'postgresql'
      if (schemaProvider !== 'postgresql') {
        errors.push(
          `prisma/schema.prisma still says provider = "sqlite" after conversion — ` +
            'the image would generate a SQLite client while the pod is handed the Postgres URL.',
        )
      }
    } catch (err: any) {
      errors.push(`Could not convert prisma/schema.prisma to Postgres: ${err?.message ?? err}`)
    }
  }

  // 2. The client module. Current projects have `src/lib/db.ts` (the runtime
  // template's file); older ones have `db.tsx`, which the LibSQL rewrite in
  // `server.ts` still targets. Looking only for `db.tsx` left every current
  // project on `PrismaLibSql` — the SQLite client QA found inside a Postgres
  // pod on staging (SHO-551, QA round 5).
  const dbCandidates = ['src/lib/db.ts', 'src/lib/db.tsx'] as const
  const dbRel = dbCandidates.find((rel) => existsSync(join(contextDir, rel))) ?? null
  if (!dbRel) {
    errors.push(
      'No src/lib/db.ts (or db.tsx) in the build context — there is no db module to point at Postgres.',
    )
  } else {
    dbModule = dbRel
    const dbPath = join(contextDir, dbRel)
    const existing = readFileSync(dbPath, 'utf-8')
    if (!existing.includes('@prisma/adapter-pg')) {
      // Keep the app's own import path rather than assuming the template layout.
      const clientImport = existing.includes("from './generated/prisma/client'")
        ? './generated/prisma/client'
        : '../generated/prisma/client'
      const content = generateDbModule().replace(
        /from '\.\.\/generated\/prisma\/client'/g,
        `from '${clientImport}'`,
      )
      writeFileSync(dbPath, content, 'utf-8')
      applied = true
    }
    // Read it back: this file is the only thing that makes the pod's queries
    // reach projects-pg, so "we wrote something" is not enough.
    if (!readFileSync(dbPath, 'utf-8').includes('@prisma/adapter-pg')) {
      errors.push(`${dbRel} still does not import @prisma/adapter-pg after the rewrite.`)
    }
  }

  // 3. Runtime dependencies. `bun install --production` in the published
  // Dockerfile drops devDependencies, and `@prisma/adapter-pg` is only an
  // optional peer of the SDK — so neither package is in the image unless it is
  // written here.
  const pkgPath = join(contextDir, 'package.json')
  if (!existsSync(pkgPath)) {
    errors.push('package.json is missing from the build context, so @prisma/adapter-pg cannot be installed.')
    return result()
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    pkg.dependencies = pkg.dependencies ?? {}
    let depsChanged = false
    for (const name of REQUIRED_RUNTIME_PACKAGES) {
      const dev = pkg.devDependencies?.[name]
      if (pkg.dependencies[name]) continue
      pkg.dependencies[name] =
        dev ?? (name === 'pg' ? FALLBACK_PG_VERSION : FALLBACK_ADAPTER_VERSION)
      if (dev) delete pkg.devDependencies[name]
      depsChanged = true
    }
    if (depsChanged) {
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
      applied = true
    }
  } catch (err: any) {
    errors.push(`Could not add the Postgres adapter to dependencies: ${err?.message ?? err}`)
  }

  return result()
}
