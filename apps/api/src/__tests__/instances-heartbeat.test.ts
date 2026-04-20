// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instance Heartbeat & Adaptive Polling Tests
 *
 * Tests for the HTTP heartbeat endpoint, viewer-active signaling,
 * request-connect flow, and adaptive poll interval computation.
 *
 * Run: bun test apps/api/src/__tests__/instances-heartbeat.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockInstance = {
  id: 'inst-1',
  workspaceId: 'ws-1',
  name: 'my-laptop',
  hostname: 'my-laptop',
  os: 'darwin',
  arch: 'arm64',
  status: 'offline',
  lastSeenAt: new Date(),
  wsRequestedAt: null as Date | null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const mockPrisma = {
  instance: {
    upsert: mock(() => Promise.resolve({ ...mockInstance })),
    findUnique: mock(() => Promise.resolve({ ...mockInstance })),
    findMany: mock(() => Promise.resolve([{ ...mockInstance }])),
    update: mock(() => Promise.resolve({ ...mockInstance })),
    delete: mock(() => Promise.resolve({ ...mockInstance })),
  },
  member: {
    findFirst: mock(() => Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' })),
  },
}

// Run in local mode so the Redis-backed tunnel module short-circuits instead of
// blocking the test on a live Redis connection. Must be set before importing
// instances.ts (which transitively imports tunnel-redis).
process.env.SHOGO_LOCAL_MODE = 'true'

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(async (key: string) => {
    if (key === 'shogo_valid_key') return { workspaceId: 'ws-1', userId: 'user-1' }
    return null
  }),
}))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: mock(async () => {}),
}))

const adminUser = { id: 'user-1', userId: 'user-1', email: 'admin@test.com', role: 'super_admin' }
let currentUser: any = adminUser

// ─── Import after mocks ─────────────────────────────────────────────────────

const { instanceRoutes, _testing } = await import('../routes/instances')

function createTestApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', currentUser)
    await next()
  })
  app.route('/api', instanceRoutes())
  return app
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/instances/heartbeat', () => {
  beforeEach(() => {
    mockPrisma.instance.upsert.mockReset()
    mockPrisma.instance.upsert.mockImplementation(() =>
      Promise.resolve({ ...mockInstance, wsRequestedAt: null }),
    )
    _testing.activeViewers.clear()
  })

  test('returns 401 without API key', async () => {
    const app = createTestApp()
    const res = await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname: 'test' }),
    })
    expect(res.status).toBe(401)
  })

  test('returns 401 with invalid API key', async () => {
    const app = createTestApp()
    const res = await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'shogo_invalid' },
      body: JSON.stringify({ hostname: 'test' }),
    })
    expect(res.status).toBe(401)
  })

  test('returns 400 without hostname', async () => {
    const app = createTestApp()
    const res = await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'shogo_valid_key' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('upserts instance and returns idle poll interval', async () => {
    const app = createTestApp()
    const res = await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'shogo_valid_key' },
      body: JSON.stringify({ hostname: 'my-laptop', name: 'My Laptop', os: 'darwin', arch: 'arm64' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.instanceId).toBe('inst-1')
    expect(data.nextPollIn).toBe(_testing.POLL_INTERVAL_IDLE_S)
    expect(data.wsRequested).toBe(false)
    expect(mockPrisma.instance.upsert).toHaveBeenCalled()
  })

  test('returns faster poll when viewer is active', async () => {
    _testing.markViewerActive('ws-1')

    const app = createTestApp()
    const res = await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'shogo_valid_key' },
      body: JSON.stringify({ hostname: 'my-laptop' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.nextPollIn).toBe(_testing.POLL_INTERVAL_VIEWER_S)
    expect(data.wsRequested).toBe(false)
  })

  test('returns wsRequested and fastest poll when WS requested', async () => {
    mockPrisma.instance.upsert.mockImplementation(() =>
      Promise.resolve({ ...mockInstance, wsRequestedAt: new Date() }),
    )

    const app = createTestApp()
    const res = await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'shogo_valid_key' },
      body: JSON.stringify({ hostname: 'my-laptop' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.nextPollIn).toBe(_testing.POLL_INTERVAL_WS_REQUESTED_S)
    expect(data.wsRequested).toBe(true)
  })

  test('expired wsRequestedAt is not treated as requested', async () => {
    const expired = new Date(Date.now() - _testing.WS_REQUEST_TTL_MS - 1000)
    mockPrisma.instance.upsert.mockImplementation(() =>
      Promise.resolve({ ...mockInstance, wsRequestedAt: expired }),
    )

    const app = createTestApp()
    const res = await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'shogo_valid_key' },
      body: JSON.stringify({ hostname: 'my-laptop' }),
    })
    const data = await res.json()
    expect(data.wsRequested).toBe(false)
    expect(data.nextPollIn).toBe(_testing.POLL_INTERVAL_IDLE_S)
  })
})

describe('POST /api/instances/viewer-active', () => {
  beforeEach(() => {
    currentUser = adminUser
    _testing.activeViewers.clear()
    mockPrisma.member.findFirst.mockReset()
    mockPrisma.member.findFirst.mockImplementation(() =>
      Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' }),
    )
  })

  test('returns 401 without auth', async () => {
    const noAuthUser = { id: null, userId: null, email: null }
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('auth', noAuthUser)
      await next()
    })
    app.route('/api', instanceRoutes())

    const res = await app.request('/api/instances/viewer-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    expect(res.status).toBe(401)
  })

  test('marks workspace as having active viewer', async () => {
    const app = createTestApp()
    const res = await app.request('/api/instances/viewer-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    expect(res.status).toBe(200)
    expect(await _testing.isViewerActive('ws-1')).toBe(true)
  })

  test('returns 403 for non-member', async () => {
    mockPrisma.member.findFirst.mockImplementation(() => Promise.resolve(null))

    const app = createTestApp()
    const res = await app.request('/api/instances/viewer-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-other' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/instances/:id/request-connect', () => {
  beforeEach(() => {
    currentUser = adminUser
    mockPrisma.instance.findUnique.mockReset()
    mockPrisma.instance.findUnique.mockImplementation(() => Promise.resolve({ ...mockInstance }))
    mockPrisma.instance.update.mockReset()
    mockPrisma.instance.update.mockImplementation(() => Promise.resolve({ ...mockInstance }))
    mockPrisma.member.findFirst.mockReset()
    mockPrisma.member.findFirst.mockImplementation(() =>
      Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' }),
    )
    _testing.tunnels.clear()
    _testing.activeViewers.clear()
  })

  test('sets wsRequestedAt and returns requested status', async () => {
    const app = createTestApp()
    const res = await app.request('/api/instances/inst-1/request-connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('requested')
    expect(mockPrisma.instance.update).toHaveBeenCalled()
    expect(await _testing.isViewerActive('ws-1')).toBe(true)
  })

  test('returns already_connected if tunnel exists', async () => {
    _testing.tunnels.set('inst-1', { ws: {} as any, instanceId: 'inst-1', workspaceId: 'ws-1', pendingRequests: new Map(), streamHandlers: new Map() })

    const app = createTestApp()
    const res = await app.request('/api/instances/inst-1/request-connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('already_connected')

    _testing.tunnels.clear()
  })

  test('returns 404 for unknown instance', async () => {
    mockPrisma.instance.findUnique.mockImplementation(() => Promise.resolve(null))

    const app = createTestApp()
    const res = await app.request('/api/instances/unknown/request-connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(404)
  })
})

describe('Adaptive poll interval computation', () => {
  beforeEach(() => {
    _testing.activeViewers.clear()
  })

  test('returns idle interval by default', async () => {
    expect(await _testing.computeNextPollIn('inst-1', 'ws-1', null)).toBe(_testing.POLL_INTERVAL_IDLE_S)
  })

  test('returns viewer interval when viewer is active', async () => {
    await _testing.markViewerActive('ws-1')
    expect(await _testing.computeNextPollIn('inst-1', 'ws-1', null)).toBe(_testing.POLL_INTERVAL_VIEWER_S)
  })

  test('returns ws-requested interval when wsRequested and takes priority over viewer', async () => {
    await _testing.markViewerActive('ws-1')
    const recent = new Date()
    expect(await _testing.computeNextPollIn('inst-1', 'ws-1', recent)).toBe(_testing.POLL_INTERVAL_WS_REQUESTED_S)
  })

  test('expired wsRequestedAt falls back to viewer or idle', async () => {
    const expired = new Date(Date.now() - _testing.WS_REQUEST_TTL_MS - 1000)
    expect(await _testing.computeNextPollIn('inst-1', 'ws-1', expired)).toBe(_testing.POLL_INTERVAL_IDLE_S)

    await _testing.markViewerActive('ws-1')
    expect(await _testing.computeNextPollIn('inst-1', 'ws-1', expired)).toBe(_testing.POLL_INTERVAL_VIEWER_S)
  })
})

describe('GET /api/instances (list with status)', () => {
  beforeEach(() => {
    currentUser = adminUser
    _testing.tunnels.clear()
    mockPrisma.instance.findMany.mockReset()
    mockPrisma.member.findFirst.mockReset()
    mockPrisma.member.findFirst.mockImplementation(() =>
      Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' }),
    )
  })

  test('reports online for instances with active tunnel', async () => {
    _testing.tunnels.set('inst-1', { ws: {} as any, instanceId: 'inst-1', workspaceId: 'ws-1', pendingRequests: new Map(), streamHandlers: new Map() })
    mockPrisma.instance.findMany.mockImplementation(() =>
      Promise.resolve([{ ...mockInstance, lastSeenAt: new Date() }]),
    )

    const app = createTestApp()
    const res = await app.request('/api/instances?workspaceId=ws-1')
    const data = await res.json()
    expect(data.instances[0].status).toBe('online')

    _testing.tunnels.clear()
  })

  test('reports heartbeat for recently-seen instances without tunnel', async () => {
    mockPrisma.instance.findMany.mockImplementation(() =>
      Promise.resolve([{ ...mockInstance, lastSeenAt: new Date() }]),
    )

    const app = createTestApp()
    const res = await app.request('/api/instances?workspaceId=ws-1')
    const data = await res.json()
    expect(data.instances[0].status).toBe('heartbeat')
  })

  test('reports offline for stale instances', async () => {
    const staleDate = new Date(Date.now() - 300_000)
    mockPrisma.instance.findMany.mockImplementation(() =>
      Promise.resolve([{ ...mockInstance, lastSeenAt: staleDate }]),
    )

    const app = createTestApp()
    const res = await app.request('/api/instances?workspaceId=ws-1')
    const data = await res.json()
    expect(data.instances[0].status).toBe('offline')
  })
})
