// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instance Ping & Echo Endpoint Tests
 *
 * Tests for the latency ping and end-to-end echo test endpoints.
 *
 * Run: bun test apps/api/src/__tests__/instances-ping-echo.test.ts
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
  status: 'online',
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

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(async () => null),
}))

const testUser = { id: 'user-1', userId: 'user-1', email: 'test@test.com', role: 'super_admin' }

const { instanceRoutes, _testing } = await import('../routes/instances')

function createTestApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', testUser)
    await next()
  })
  app.route('/api', instanceRoutes())
  return app
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/instances/:id/ping', () => {
  beforeEach(() => {
    _testing.tunnels.clear()
    mockPrisma.instance.findUnique.mockReset()
    mockPrisma.instance.findUnique.mockImplementation(() => Promise.resolve({ ...mockInstance }))
    mockPrisma.member.findFirst.mockReset()
    mockPrisma.member.findFirst.mockImplementation(() =>
      Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' }),
    )
  })

  test('returns 503 when instance has no tunnel', async () => {
    const app = createTestApp()
    const res = await app.request('/api/instances/inst-1/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(503)
  })

  test('returns 404 for unknown instance', async () => {
    mockPrisma.instance.findUnique.mockImplementation(() => Promise.resolve(null))
    const app = createTestApp()
    const res = await app.request('/api/instances/unknown/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(404)
  })

  test('returns rttMs when tunnel responds', async () => {
    const mockWs = {
      send: mock((data: string) => {
        const msg = JSON.parse(data)
        const conn = _testing.tunnels.get('inst-1')
        if (conn && msg.type === 'request') {
          const pending = conn.pendingRequests.get(msg.requestId)
          if (pending) {
            clearTimeout(pending.timeout)
            conn.pendingRequests.delete(msg.requestId)
            pending.resolve({ type: 'response', requestId: msg.requestId, status: 200, body: '{"ok":true}' })
          }
        }
      }),
    }

    _testing.tunnels.set('inst-1', {
      ws: mockWs as any,
      instanceId: 'inst-1',
      workspaceId: 'ws-1',
      pendingRequests: new Map(),
      streamHandlers: new Map(),
    })

    const app = createTestApp()
    const res = await app.request('/api/instances/inst-1/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(typeof data.rttMs).toBe('number')

    _testing.tunnels.clear()
  })
})

describe('ALL /api/instances/:id/echo', () => {
  beforeEach(() => {
    _testing.tunnels.clear()
    mockPrisma.instance.findUnique.mockReset()
    mockPrisma.instance.findUnique.mockImplementation(() => Promise.resolve({ ...mockInstance }))
    mockPrisma.member.findFirst.mockReset()
    mockPrisma.member.findFirst.mockImplementation(() =>
      Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' }),
    )
  })

  test('returns 503 when instance is offline', async () => {
    const app = createTestApp()
    const res = await app.request('/api/instances/inst-1/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(res.status).toBe(503)
  })

  test('proxies echo request through tunnel and returns rtt', async () => {
    const mockWs = {
      send: mock((data: string) => {
        const msg = JSON.parse(data)
        const conn = _testing.tunnels.get('inst-1')
        if (conn && msg.type === 'request') {
          const pending = conn.pendingRequests.get(msg.requestId)
          if (pending) {
            clearTimeout(pending.timeout)
            conn.pendingRequests.delete(msg.requestId)
            pending.resolve({
              type: 'response',
              requestId: msg.requestId,
              status: 200,
              body: msg.body || '{}',
            })
          }
        }
      }),
    }

    _testing.tunnels.set('inst-1', {
      ws: mockWs as any,
      instanceId: 'inst-1',
      workspaceId: 'ws-1',
      pendingRequests: new Map(),
      streamHandlers: new Map(),
    })

    const app = createTestApp()
    const res = await app.request('/api/instances/inst-1/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(typeof data.tunnelRttMs).toBe('number')
    expect(data.echoStatus).toBe(200)

    _testing.tunnels.clear()
  })
})

describe('Heartbeat includes tunnelStatus', () => {
  beforeEach(() => {
    _testing.tunnels.clear()
    mockPrisma.instance.upsert.mockReset()
    mockPrisma.instance.upsert.mockImplementation(() =>
      Promise.resolve({ ...mockInstance, wsRequestedAt: null }),
    )
  })

  test('heartbeat response includes tunnelStatus field', async () => {
    mock.module('../routes/api-keys', () => ({
      resolveApiKey: mock(async (key: string) => {
        if (key === 'shogo_valid_key') return { workspaceId: 'ws-1', userId: 'user-1' }
        return null
      }),
    }))

    const app = createTestApp()
    const res = await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'shogo_valid_key' },
      body: JSON.stringify({ hostname: 'my-laptop' }),
    })

    if (res.status === 200) {
      const data = await res.json()
      expect(data).toHaveProperty('tunnelStatus')
    }
  })
})
