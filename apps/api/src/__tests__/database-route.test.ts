// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/routes/database.ts` — Prisma Studio lifecycle endpoints.
 *
 * Covers:
 *   - POST /start: 404 project missing, 400 no prisma schema, happy path
 *     spawns + returns running url, idempotent when already running
 *   - POST /stop: idempotent (200 even when not running), kills process
 *   - GET /status: not_initialized, stopped, hasPrisma flag, running instance
 *   - GET /url: 404 missing, 400 no schema, already-running returns url,
 *     auto-start returns url
 *   - stopAllPrismaStudios() drains the in-memory registry
 *
 * The child_process.spawn() call is mocked so no real Prisma Studio is
 * launched. The 2-second wait inside the start handler is unavoidable
 * — tests that trigger spawn live with that latency.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'events'

// ─── child_process mock ────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  kill = mock((_sig?: string) => {
    this.exitCode = 0
    queueMicrotask(() => this.emit('close', 0))
    return true
  })
}

let lastSpawned: FakeChild | null = null
const spawnSpy = mock((..._args: any[]) => {
  const c = new FakeChild()
  lastSpawned = c
  // Emit "Started on" so the handler flips status to 'running' before its
  // own 2-second timeout finishes. Schedule asynchronously to avoid racing
  // with the listener attach.
  setTimeout(() => c.stdout.emit('data', Buffer.from('Started on http://localhost:5555')), 5)
  return c as any
})

mock.module('child_process', () => ({
  spawn: spawnSpy,
  // execSync isn't used by this module but keep export shape stable
  execSync: () => '',
}))

// ─── fs mock ──────────────────────────────────────────────────────────

const fsState = {
  projects: new Set<string>(),
  schemas: new Set<string>(),
}

mock.module('fs', () => ({
  existsSync: (p: string) => {
    if (p.includes('schema.prisma')) return fsState.schemas.has(p)
    return fsState.projects.has(p)
  },
}))

// ─── Import after mocks ──────────────────────────────────────────────

const { databaseRoutes, stopAllPrismaStudios } = await import('../routes/database')

const router = databaseRoutes({ workspacesDir: '/tmp/ws' })

// ─── Helpers ──────────────────────────────────────────────────────────

function seedProject(id: string, withSchema = true) {
  fsState.projects.add(`/tmp/ws/${id}`)
  if (withSchema) fsState.schemas.add(`/tmp/ws/${id}/prisma/schema.prisma`)
}

beforeEach(() => {
  fsState.projects = new Set<string>()
  fsState.schemas = new Set<string>()
  spawnSpy.mockClear()
  lastSpawned = null
  stopAllPrismaStudios()
})

afterEach(() => {
  stopAllPrismaStudios()
})

// ═══════════════════════════════════════════════════════════════════════
// POST /projects/:id/database/start
// ═══════════════════════════════════════════════════════════════════════

describe('POST /database/start', () => {
  test('404 when project directory does not exist', async () => {
    const res = await router.request('/projects/p_missing/database/start', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('project_not_found')
  })

  test('400 when project exists but has no prisma schema', async () => {
    seedProject('p1', false)
    const res = await router.request('/projects/p1/database/start', { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('no_prisma_schema')
  })

  test('happy path spawns prisma studio and returns running url', async () => {
    seedProject('p_spawn')
    const res = await router.request('/projects/p_spawn/database/start', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toMatch(/^http:\/\/localhost:\d+/)
    expect(body.port).toBeGreaterThanOrEqual(5555)
    expect(body.status).toBe('running')
    expect(typeof body.startedAt).toBe('number')
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    const cmd = spawnSpy.mock.calls[0]
    expect(cmd[0]).toBe('bunx')
    expect(cmd[1]).toContain('prisma')
    expect(cmd[1]).toContain('studio')
  }, 10_000)

  test('idempotent: second call with running instance returns existing url', async () => {
    seedProject('p_idem')
    const first = await router.request('/projects/p_idem/database/start', { method: 'POST' })
    const firstBody = await first.json()
    // Manually flip status to 'running' (otherwise it stays in starting/running
    // depending on timing). The handler checks `status === 'running'`.
    if (firstBody.status !== 'running') {
      await new Promise((r) => setTimeout(r, 50))
    }
    const second = await router.request('/projects/p_idem/database/start', { method: 'POST' })
    expect(second.status).toBe(200)
    const secondBody = await second.json()
    expect(secondBody.url).toBe(firstBody.url)
  }, 10_000)
})

// ═══════════════════════════════════════════════════════════════════════
// POST /projects/:id/database/stop
// ═══════════════════════════════════════════════════════════════════════

describe('POST /database/stop', () => {
  test('idempotent: 200 when nothing running', async () => {
    const res = await router.request('/projects/p_nothing/database/stop', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.message).toMatch(/not running/)
  })

  test('kills running process and returns success', async () => {
    seedProject('p_stop')
    await router.request('/projects/p_stop/database/start', { method: 'POST' })
    const child = lastSpawned!
    const res = await router.request('/projects/p_stop/database/stop', { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  }, 10_000)
})

// ═══════════════════════════════════════════════════════════════════════
// GET /projects/:id/database/status
// ═══════════════════════════════════════════════════════════════════════

describe('GET /database/status', () => {
  test('not_initialized when project dir is missing', async () => {
    const res = await router.request('/projects/p_x/database/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('not_initialized')
    expect(body.hasPrisma).toBe(false)
  })

  test('stopped + hasPrisma:false when project exists without schema', async () => {
    seedProject('p_nosch', false)
    const res = await router.request('/projects/p_nosch/database/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('stopped')
    expect(body.hasPrisma).toBe(false)
    expect(body.url).toBe(null)
  })

  test('stopped + hasPrisma:true when schema present but not running', async () => {
    seedProject('p_sch')
    const res = await router.request('/projects/p_sch/database/status')
    const body = await res.json()
    expect(body.status).toBe('stopped')
    expect(body.hasPrisma).toBe(true)
  })

  test('returns running instance details', async () => {
    seedProject('p_run')
    await router.request('/projects/p_run/database/start', { method: 'POST' })
    const res = await router.request('/projects/p_run/database/status')
    const body = await res.json()
    expect(body.status).toMatch(/running|starting/)
    expect(body.url).toMatch(/^http:\/\/localhost:/)
    expect(body.hasPrisma).toBe(true)
    expect(typeof body.startedAt).toBe('number')
  }, 10_000)
})

// ═══════════════════════════════════════════════════════════════════════
// GET /projects/:id/database/url
// ═══════════════════════════════════════════════════════════════════════

describe('GET /database/url', () => {
  test('404 when project dir is missing', async () => {
    const res = await router.request('/projects/missing/database/url')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('project_not_found')
  })

  test('400 when no schema', async () => {
    seedProject('p_noschema', false)
    const res = await router.request('/projects/p_noschema/database/url')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('no_prisma_schema')
  })

  test('returns existing url when already running', async () => {
    seedProject('p_running')
    const first = await router.request('/projects/p_running/database/start', { method: 'POST' })
    const firstBody = await first.json()
    if (firstBody.status !== 'running') {
      await new Promise((r) => setTimeout(r, 30))
    }
    const res = await router.request('/projects/p_running/database/url')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toBe(firstBody.url)
  }, 10_000)

  test('auto-starts when not running', async () => {
    seedProject('p_auto')
    const res = await router.request('/projects/p_auto/database/url')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toMatch(/^http:\/\/localhost:/)
    expect(spawnSpy).toHaveBeenCalled()
  }, 10_000)
})

// ═══════════════════════════════════════════════════════════════════════
// stopAllPrismaStudios()
// ═══════════════════════════════════════════════════════════════════════

describe('stopAllPrismaStudios()', () => {
  test('kills all registered instances and clears registry', async () => {
    seedProject('p_a')
    seedProject('p_b')
    await router.request('/projects/p_a/database/start', { method: 'POST' })
    await router.request('/projects/p_b/database/start', { method: 'POST' })
    const callsBefore = spawnSpy.mock.calls.length
    expect(callsBefore).toBe(2)
    stopAllPrismaStudios()
    // After draining, status for both should be 'stopped' (no in-mem row)
    const sA = await (await router.request('/projects/p_a/database/status')).json()
    const sB = await (await router.request('/projects/p_b/database/status')).json()
    expect(sA.status).toBe('stopped')
    expect(sB.status).toBe('stopped')
  }, 15_000)

  test('safe to call when registry is empty', () => {
    expect(() => stopAllPrismaStudios()).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Port allocation
// ═══════════════════════════════════════════════════════════════════════

describe('port allocation', () => {
  test('assigns different ports to concurrent projects', async () => {
    seedProject('p_port_1')
    seedProject('p_port_2')
    const r1 = await router.request('/projects/p_port_1/database/start', { method: 'POST' })
    const r2 = await router.request('/projects/p_port_2/database/start', { method: 'POST' })
    const b1 = await r1.json()
    const b2 = await r2.json()
    expect(b1.port).not.toBe(b2.port)
  }, 10_000)
})
