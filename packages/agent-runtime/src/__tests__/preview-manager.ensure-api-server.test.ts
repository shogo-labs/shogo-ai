// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-403 — `PreviewManager.ensureApiServer()` and `fetchActiveRoutes()`.
 *
 * On-demand start is what removes the "#1 platform workaround": before it,
 * only a `crashed` sidecar self-healed, so an `idle` or `stopped` project
 * answered `/api/*` with 503 forever and agents learned to touch files and
 * poll build.log. These tests drive a REAL PreviewManager against a REAL
 * local HTTP server standing in for `server.tsx` (so the readiness probe and
 * `/__shogo/routes` are exercised end to end) with only the spawn stubbed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PreviewManager, normalizeRouteList, API_HEALTH_PATH, API_ROUTES_PATH } from '../preview-manager'

let dir: string
/** Stand-in for `server.tsx`, or null when the test wants a dead port. */
let sidecar: { stop: (force?: boolean) => void; port: number } | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-ensure-'))
})

afterEach(() => {
  sidecar?.stop(true)
  sidecar = null
  rmSync(dir, { recursive: true, force: true })
})

/** Start a fake sidecar that answers the runtime's introspection endpoints. */
function startSidecar(options: { routes?: Array<{ method: string; path: string }>; legacyOnly?: boolean } = {}) {
  const routes = options.routes ?? [
    { method: 'GET', path: '/api/users' },
    { method: 'POST', path: '/api/users' },
    { method: 'GET', path: '/api/users/:id' },
    { method: 'GET', path: '/api/leads' },
  ]
  sidecar = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === API_HEALTH_PATH && !options.legacyOnly) {
        return Response.json({ ok: true, startedAt: new Date().toISOString(), pid: process.pid })
      }
      if (path === API_ROUTES_PATH && !options.legacyOnly) {
        return Response.json({ routes })
      }
      if (path === '/health') return Response.json({ ok: true })
      return new Response('not found', { status: 404 })
    },
  })
  return sidecar
}

function mk(over: Record<string, any> = {}) {
  return new PreviewManager({
    workspaceDir: dir,
    runtimePort: 38961,
    publicUrl: 'https://preview.example/abc',
    localMode: false,
    ...over,
  }) as any
}

/** Make `apiServerPort` report a bound, listening sidecar. */
function bind(pm: any, port: number) {
  pm.apiServerProcess = { killed: false, kill: () => {} }
  pm.apiListening = true
  pm.apiPort = port
}

describe('normalizeRouteList', () => {
  it('strips the /api prefix and the leading slash, dedupes, keeps order', () => {
    expect(
      normalizeRouteList([
        { method: 'GET', path: '/api/users' },
        { method: 'POST', path: '/api/users' },
        { path: '/leads' },
        '/health',
        { method: 'GET', path: '/api/users/' },
        { nope: true },
        42,
      ]),
    ).toEqual(['users', 'leads', 'health'])
  })
})

describe('PreviewManager.ensureApiServer', () => {
  it('returns phase "none" without doing anything when the project has no API server', async () => {
    const pm = mk()
    pm.hasApiServer = false
    let starts = 0
    pm.startApiServer = async () => { starts++ }

    const result = await pm.ensureApiServer({ timeoutMs: 200 })
    expect(result.phase).toBe('none')
    expect(result.port).toBeNull()
    expect(result.routes).toEqual([])
    expect(starts).toBe(0)
  })

  it('cold boot: an idle project with the bundler up starts only the sidecar and waits for /__shogo/health', async () => {
    const server = startSidecar()
    const pm = mk({ apiPort: server.port })
    pm.started = true
    pm.apiPhase = 'idle'
    let starts = 0
    pm.startApiServer = async () => {
      starts++
      pm.apiPhase = 'starting'
      bind(pm, server.port)
      pm.apiPhase = 'healthy'
      pm.lastApiStderr = null
    }

    const result = await pm.ensureApiServer({ timeoutMs: 5000 })
    expect(starts).toBe(1)
    expect(result.phase).toBe('healthy')
    expect(result.port).toBe(server.port)
    expect(result.reloadedAt).toBeGreaterThan(0)
    expect(result.routes).toContain('users')
    expect(result.routesSource).toBe('server')
  })

  it('20 concurrent callers share one in-flight ensure → exactly one spawn', async () => {
    const server = startSidecar()
    const pm = mk({ apiPort: server.port })
    pm.started = true
    pm.apiPhase = 'idle'
    let starts = 0
    pm.startApiServer = async () => {
      starts++
      await new Promise((r) => setTimeout(r, 20))
      bind(pm, server.port)
      pm.apiPhase = 'healthy'
    }

    const results = await Promise.all(Array.from({ length: 20 }, () => pm.ensureApiServer({ timeoutMs: 5000 })))
    expect(starts).toBe(1)
    expect(results.every((r) => r.phase === 'healthy')).toBe(true)
    expect(results.every((r) => r.port === server.port)).toBe(true)
  })

  it('a deliberate stop is respected: stopped + stoppedByUser does not restart', async () => {
    const pm = mk()
    pm.apiPhase = 'stopped'
    pm.markStoppedByUser()
    let restarts = 0
    pm.restartApiServerOnly = async () => { restarts++ }

    const result = await pm.ensureApiServer({ timeoutMs: 300 })
    expect(restarts).toBe(0)
    expect(result.phase).toBe('stopped')
    expect(result.port).toBeNull()
  })

  it('a quiesce-left "stopped" is restartable on demand', async () => {
    const server = startSidecar()
    const pm = mk({ apiPort: server.port })
    pm.apiPhase = 'stopped' // as quiesceApiServer() leaves it, stoppedByUser === false
    let restarts = 0
    pm.restartApiServerOnly = async () => {
      restarts++
      bind(pm, server.port)
      pm.apiPhase = 'healthy'
    }

    const result = await pm.ensureApiServer({ timeoutMs: 5000 })
    expect(restarts).toBe(1)
    expect(result.phase).toBe('healthy')
  })

  it('a crashed sidecar gets one recovery attempt per ensure call', async () => {
    const server = startSidecar()
    const pm = mk({ apiPort: server.port })
    pm.apiPhase = 'crashed'
    pm.lastGenerateError = 'error: P1012 schema.prisma: model User is invalid'
    let recoveries = 0
    pm.startApiServer = async () => {
      recoveries++
      bind(pm, server.port)
      pm.apiPhase = 'healthy'
    }

    const result = await pm.ensureApiServer({ timeoutMs: 5000 })
    expect(recoveries).toBe(1)
    expect(result.phase).toBe('healthy')
  })

  it('a genuinely broken server returns crashed + buildError instead of looping', async () => {
    const pm = mk()
    pm.apiPhase = 'idle'
    pm.started = true
    pm.lastApiStderr = "error: Cannot find module './custom-routes'"
    pm.startApiServer = async () => {
      pm.apiPhase = 'crashed'
    }

    const started = Date.now()
    const result = await pm.ensureApiServer({ timeoutMs: 5000 })
    // It must give up as soon as the phase is terminal, not burn the budget.
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result.phase).toBe('crashed')
    expect(result.port).toBeNull()
    expect(result.buildError).toContain('Cannot find module')
  })

  it('an old server.tsx without /__shogo/health still counts as healthy (via /health)', async () => {
    const server = startSidecar({ legacyOnly: true })
    const pm = mk({ apiPort: server.port })
    pm.started = true
    pm.apiPhase = 'idle'
    pm.startApiServer = async () => {
      bind(pm, server.port)
      pm.apiPhase = 'healthy'
    }

    const result = await pm.ensureApiServer({ timeoutMs: 5000 })
    expect(result.phase).toBe('healthy')
    // No /__shogo/routes on this server → the file-based list, and it says so.
    expect(result.routesSource).toBe('generated-files')
  })
})

describe('PreviewManager.fetchActiveRoutes', () => {
  it('asks the running server and reports routesSource "server" (custom routes included)', async () => {
    const server = startSidecar()
    const pm = mk()
    bind(pm, server.port)

    const result = await pm.fetchActiveRoutes()
    expect(result.routesSource).toBe('server')
    expect(result.routes).toEqual(['users', 'users/:id', 'leads'])
  })

  it('falls back to the generated route files when no server is listening', async () => {
    const pm = mk()
    const result = await pm.fetchActiveRoutes()
    expect(result.routesSource).toBe('generated-files')
    expect(result.routes).toEqual([])
  })
})

describe('PreviewManager.apiServerStatus', () => {
  it('reports phase/port/routes/buildError without starting anything', async () => {
    const server = startSidecar()
    const pm = mk()
    bind(pm, server.port)
    pm.apiPhase = 'healthy'
    pm.lastGenerateError = null

    let starts = 0
    pm.startApiServer = async () => { starts++ }

    const status = await pm.apiServerStatus()
    expect(starts).toBe(0)
    expect(status.phase).toBe('healthy')
    expect(status.port).toBe(server.port)
    expect(status.routesSource).toBe('server')
    expect(status.routes).toContain('leads')
    expect(status.buildError).toBeNull()
  })
})
