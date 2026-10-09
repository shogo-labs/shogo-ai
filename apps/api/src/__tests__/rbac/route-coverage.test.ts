// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Every route under `/api/projects/:projectId` must declare the permission it
 * needs in `lib/authz/project-routes.ts`; otherwise writes silently fall back
 * to `project:update` and reads to `project:read`, which may be too weak for
 * reads that expose secrets. `server.ts` cannot be imported in tests, so
 * this scans route registrations in the API source instead of walking a live
 * router. Routers mounted at `/api/projects` register `/:projectId/...`.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import type { ProjectPermission } from '@shogo/authz'
import { isDeclaredProjectRoute, projectRoutePermission } from '../../lib/authz/project-routes'

const SRC = resolve(import.meta.dir, '../..')
const SKIP_DIRS = new Set(['__tests__', 'generated', 'node_modules'])

/** Routers whose `/:projectId/...` paths are mounted somewhere other than `/api/projects`. */
const NON_PROJECT_MOUNTS = new Set<string>([
  'routes/external-preview.ts',
  // Mounted at /api/internal, authenticated by runtime token, not requireProjectAccess.
  'routes/internal.ts',
  'routes/internal-runtime-routes.ts',
  'routes/internal-project-trust.ts',
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

const ROUTE_RE = /\.\s*(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\2/g

interface Found { file: string; method: string; template: string }

function projectSubpath(path: string, file: string): string | null {
  if (NON_PROJECT_MOUNTS.has(file)) return null
  const m = path.match(/^(?:\/api)?\/projects\/:(?:projectId|id)(\/.*)$/) ?? path.match(/^\/:projectId(\/.*)$/)
  return m ? m[1] : null
}

function findProjectRoutes(): Found[] {
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
  const routes = findProjectRoutes()
  const undeclared = (method: (m: string) => boolean) =>
    routes
      .filter((r) => method(r.method) && !isDeclaredProjectRoute(r.method, r.template))
      .map((r) => `${r.method} ${r.template}  (${r.file})`)

  test('the scan finds the known project routers', () => {
    const files = new Set(routes.map((r) => r.file))
    expect(files.has('server.ts')).toBe(true)
    expect(routes.filter((r) => r.method !== 'GET').length).toBeGreaterThan(30)
    expect(routes.filter((r) => r.method === 'GET').length).toBeGreaterThan(30)
  })

  test('every mutating /api/projects/:projectId route declares its permission', () => {
    expect(undeclared((m) => m !== 'GET')).toEqual([])
  })

  test('every GET route is reviewed: listed as a plain read or given a rule', () => {
    expect(undeclared((m) => m === 'GET')).toEqual([])
  })
})

describe('sensitive reads', () => {
  test.each([
    ['GET', '/database/url', 'project:update'],
    ['GET', '/database/proxy/tables', 'project:update'],
    ['GET', '/terminal/sessions', 'project:update'],
    ['GET', '/terminal/commands', 'project:update'],
    ['GET', '/auth-config', 'project.settings:manage'],
    ['GET', '/auth-users', 'project.settings:manage'],
    ['GET', '/github/authorize', 'project.settings:manage'],
    ['GET', '/agent-proxy/agent/config', 'project.settings:manage'],
    ['GET', '/download', 'project:export'],
    ['GET', '/agent-proxy/agent/chat/history', 'project:read'],
    ['GET', '/files/src/App.tsx', 'project:read'],
  ])('%s %s needs %s', (method, path, permission) => {
    expect(projectRoutePermission(method, path)).toBe(permission as ProjectPermission)
  })
})
