// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Every mutating route under `/api/projects/:projectId` must declare the
 * permission it needs in `lib/authz/project-routes.ts`; otherwise it silently
 * falls back to `project:update`. `server.ts` cannot be imported in tests, so
 * this scans route registrations in the API source instead of walking a live
 * router. Routers mounted at `/api/projects` register `/:projectId/...`.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { isDeclaredProjectRoute } from '../../lib/authz/project-routes'

const SRC = resolve(import.meta.dir, '../..')
const SKIP_DIRS = new Set(['__tests__', 'generated', 'node_modules'])

/** Routers whose `/:projectId/...` paths are mounted somewhere other than `/api/projects`. */
const NON_PROJECT_MOUNTS = new Set<string>([
  'routes/external-preview.ts',
  // Mounted at /api/internal, authenticated by runtime token, not requireProjectAccess.
  'routes/internal.ts',
  'routes/internal-runtime-routes.ts',
])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) sourceFiles(full, out)
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

const ROUTE_RE = /\.\s*(post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\2/g

interface Found { file: string; method: string; template: string }

function projectSubpath(path: string, file: string): string | null {
  if (NON_PROJECT_MOUNTS.has(file)) return null
  const m = path.match(/^(?:\/api)?\/projects\/:(?:projectId|id)(\/.*)$/) ?? path.match(/^\/:projectId(\/.*)$/)
  return m ? m[1] : null
}

function findMutatingProjectRoutes(): Found[] {
  const found: Found[] = []
  for (const abs of sourceFiles(SRC)) {
    const file = relative(SRC, abs)
    const text = readFileSync(abs, 'utf-8')
    for (const m of text.matchAll(ROUTE_RE)) {
      const sub = projectSubpath(m[3], file)
      if (!sub) continue
      found.push({ file, method: m[1].toUpperCase(), template: sub.replace(/\/$/, '') || '/' })
    }
  }
  return found
}

describe('project route coverage', () => {
  const routes = findMutatingProjectRoutes()

  test('the scan finds the known project routers', () => {
    const files = new Set(routes.map((r) => r.file))
    expect(files.has('server.ts')).toBe(true)
    expect(routes.length).toBeGreaterThan(30)
  })

  test('every mutating /api/projects/:projectId route declares its permission', () => {
    const undeclared = routes
      .filter((r) => !isDeclaredProjectRoute(r.method, r.template))
      .map((r) => `${r.method} ${r.template}  (${r.file})`)
    expect(undeclared).toEqual([])
  })
})
