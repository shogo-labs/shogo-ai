// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the runtime-pod side of the Problems tab.
 *
 * The shared `diagnosticsRoutes` factory is already covered by
 * `packages/shared-runtime/src/__tests__/diagnostics.test.ts`. The unique
 * surface here is the URL-rewriting wrapper (`/diagnostics` →
 * `/projects/<projectId>/diagnostics`) and the "no project assigned yet"
 * 503 path. We hammer those two seams.
 *
 * Auth integration (the `/diagnostics` prefix being added to
 * `authPrefixes`) is exercised by the shared `createRuntimeApp` test suite —
 * we don't re-implement that here.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runtimeDiagnosticsRoutes } from '../runtime-diagnostics-routes'
import {
  recordBuildError,
  _resetBuildBufferForTests,
  _clearDiagnosticsCacheForTests,
} from '@shogo/shared-runtime'

let workspacesRoot: string
let projectId: string
let workspaceDir: string

beforeEach(() => {
  workspacesRoot = mkdtempSync(join(tmpdir(), 'shogo-rdiag-'))
  projectId = 'proj_runtime'
  workspaceDir = join(workspacesRoot, projectId)
  mkdirSync(workspaceDir, { recursive: true })
  _resetBuildBufferForTests()
  _clearDiagnosticsCacheForTests()
})

afterEach(() => {
  rmSync(workspacesRoot, { recursive: true, force: true })
})

describe('runtimeDiagnosticsRoutes', () => {
  test('returns 503 when no project is assigned to the pod', async () => {
    const app = runtimeDiagnosticsRoutes({
      workspaceDir,
      getCurrentProjectId: () => undefined,
    })
    const res = await app.fetch(new Request('http://x/diagnostics'))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('no_project_assigned')
  })

  test('GET /diagnostics rewrites URL and serves diagnostics for the assigned project', async () => {
    recordBuildError(projectId, { file: 'src/App.tsx', line: 1, message: 'oops' })
    const app = runtimeDiagnosticsRoutes({
      workspaceDir,
      getCurrentProjectId: () => projectId,
    })
    const res = await app.fetch(
      new Request('http://x/diagnostics?source=build'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.diagnostics).toHaveLength(1)
    expect(body.diagnostics[0].message).toBe('oops')
  })

  test('POST /diagnostics/refresh works and bypasses the cache', async () => {
    recordBuildError(projectId, { message: 'first' })
    const app = runtimeDiagnosticsRoutes({
      workspaceDir,
      getCurrentProjectId: () => projectId,
    })

    // Prime the cache.
    const r1 = await app.fetch(new Request('http://x/diagnostics?source=build'))
    expect((await r1.json()).fromCache).toBe(false)

    recordBuildError(projectId, { message: 'second' })

    const r2 = await app.fetch(new Request('http://x/diagnostics/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: ['build'] }),
    }))
    expect(r2.status).toBe(200)
    const b2 = await r2.json()
    expect(b2.fromCache).toBe(false)
    expect(b2.diagnostics).toHaveLength(2)
  })

  test('paths other than /diagnostics fall through to next() (no body)', async () => {
    const app = runtimeDiagnosticsRoutes({
      workspaceDir,
      getCurrentProjectId: () => projectId,
    })
    const res = await app.fetch(new Request('http://x/something-else'))
    // No matching route past the middleware → 404 from Hono's notFound.
    expect(res.status).toBe(404)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PR #458 regression check — the *literal* trap that broke the terminal
  // on staging. Compose the runtime-diagnostics router with a Hono app that
  // mimics `packages/agent-runtime/src/server.ts`: register the diagnostics
  // routes BEFORE an `app.get('*')` SPA fallback that explicitly skip-lists
  // `/diagnostics`. A typo'd URL like `/diagnostics-foo` MUST return 404,
  // not `index.html` with status 200.
  // ─────────────────────────────────────────────────────────────────────────
  test('SPA fallback skip-list — unknown /diagnostics-* path 404s instead of returning index.html', async () => {
    const { Hono } = await import('hono')
    const app = new Hono()
    app.route('/', runtimeDiagnosticsRoutes({
      workspaceDir,
      getCurrentProjectId: () => projectId,
    }))
    // Mirror server.ts's static SPA fallback (the one we updated to skip `/diagnostics`).
    app.get('*', (c) => {
      const urlPath = new URL(c.req.url).pathname
      if (urlPath.startsWith('/diagnostics')) return c.notFound()
      return c.html('<!doctype html><html><body>SPA</body></html>', 200)
    })

    // Known route — still works.
    const ok = await app.fetch(new Request('http://x/diagnostics?source=build'))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type') ?? '').toContain('application/json')

    // Typo under the same prefix — 404, not HTML 200. This is the bug PR #458 fixed.
    const typo = await app.fetch(new Request('http://x/diagnostics-foo'))
    expect(typo.status).toBe(404)
    expect(typo.headers.get('content-type') ?? '').not.toContain('text/html')

    // Sibling unrelated path — falls through to SPA as expected.
    const spa = await app.fetch(new Request('http://x/some-react-route'))
    expect(spa.status).toBe(200)
    expect(spa.headers.get('content-type') ?? '').toContain('text/html')
  })
})
