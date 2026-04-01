// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instance Tunnel E2E Integration Test
 *
 * Tests the full flow: heartbeat polling -> viewer-active -> request-connect
 * -> WebSocket session -> disconnect -> back to polling.
 *
 * Uses mocked Prisma but exercises the real Hono routes in-process.
 *
 * Run: bun test apps/api/src/__tests__/instances-e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

// ─── Mocks ──────────────────────────────────────────────────────────────────

let instancesById: Map<string, any> = new Map()
let instancesByKey: Map<string, string> = new Map()

const mockPrisma = {
  instance: {
    upsert: mock(async (args: any) => {
      const compoundKey = `${args.where.workspaceId_hostname.workspaceId}:${args.where.workspaceId_hostname.hostname}`
      const existingId = instancesByKey.get(compoundKey)
      if (existingId) {
        const existing = instancesById.get(existingId)!
        Object.assign(existing, args.update, { updatedAt: new Date() })
        return { ...existing }
      }
      const created = {
        id: `inst-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ...args.create,
        wsRequestedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      instancesById.set(created.id, created)
      instancesByKey.set(compoundKey, created.id)
      return { ...created }
    }),
    findUnique: mock(async (args: any) => {
      const inst = instancesById.get(args.where.id)
      return inst ? { ...inst } : null
    }),
    findMany: mock(async (args: any) => {
      return [...instancesById.values()]
        .filter((i: any) => i.workspaceId === args.where.workspaceId)
        .map((i) => ({ ...i }))
    }),
    update: mock(async (args: any) => {
      const inst = instancesById.get(args.where.id)
      if (!inst) throw new Error('Not found')
      Object.assign(inst, args.data, { updatedAt: new Date() })
      return { ...inst }
    }),
    delete: mock(async (args: any) => {
      const inst = instancesById.get(args.where.id)
      if (!inst) throw new Error('Not found')
      instancesById.delete(args.where.id)
      return inst
    }),
  },
  member: {
    findFirst: mock(async () => ({
      id: 'member-1',
      userId: 'user-1',
      workspaceId: 'ws-e2e',
    })),
  },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(async (key: string) => {
    if (key === 'shogo_e2e_key') return { workspaceId: 'ws-e2e', userId: 'user-e2e' }
    return null
  }),
}))

const testUser = { id: 'user-1', userId: 'user-1', email: 'e2e@test.com', role: 'super_admin' }

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

// ─── E2E Flow ───────────────────────────────────────────────────────────────

describe('Instance Tunnel E2E Flow', () => {
  beforeEach(() => {
    instancesById.clear()
    instancesByKey.clear()
    _testing.tunnels.clear()
    _testing.activeViewers.clear()
  })

  test('full lifecycle: heartbeat -> viewer-active -> request-connect -> session -> disconnect', async () => {
    const app = createTestApp()

    // Step 1: Instance sends first heartbeat (registers itself)
    const hb1 = await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'shogo_e2e_key' },
      body: JSON.stringify({
        hostname: 'e2e-laptop',
        name: 'E2E Laptop',
        os: 'darwin',
        arch: 'arm64',
        metadata: { activeProjects: 2 },
      }),
    })
    expect(hb1.status).toBe(200)
    const hb1Data = await hb1.json()
    expect(hb1Data.instanceId).toBeTruthy()
    expect(hb1Data.nextPollIn).toBe(60)
    expect(hb1Data.wsRequested).toBe(false)

    const instanceId = hb1Data.instanceId

    // Step 2: User opens Remote Control page -> viewer-active
    const va = await app.request('/api/instances/viewer-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-e2e' }),
    })
    expect(va.status).toBe(200)

    // Step 3: Instance's next heartbeat now gets faster poll
    const hb2 = await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'shogo_e2e_key' },
      body: JSON.stringify({ hostname: 'e2e-laptop' }),
    })
    const hb2Data = await hb2.json()
    expect(hb2Data.nextPollIn).toBe(5)
    expect(hb2Data.wsRequested).toBe(false)

    // Step 4: User clicks "Connect" on the instance
    const rc = await app.request(`/api/instances/${instanceId}/request-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(rc.status).toBe(200)
    const rcData = await rc.json()
    expect(rcData.status).toBe('requested')

    // Step 5: Instance's next heartbeat sees wsRequested
    const hb3 = await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'shogo_e2e_key' },
      body: JSON.stringify({ hostname: 'e2e-laptop' }),
    })
    const hb3Data = await hb3.json()
    expect(hb3Data.nextPollIn).toBe(3)
    expect(hb3Data.wsRequested).toBe(true)

    // Step 6: Instance list shows the instance as heartbeat (no WS yet)
    const list1 = await app.request('/api/instances?workspaceId=ws-e2e')
    const list1Data = await list1.json()
    expect(list1Data.instances.length).toBe(1)
    expect(list1Data.instances[0].status).toBe('heartbeat')

    // Step 7: Simulate WebSocket connect (add to tunnels map)
    _testing.tunnels.set(instanceId, {
      ws: {} as any,
      instanceId,
      workspaceId: 'ws-e2e',
      pendingRequests: new Map(),
      streamHandlers: new Map(),
    })

    // Step 8: Instance list now shows online
    const list2 = await app.request('/api/instances?workspaceId=ws-e2e')
    const list2Data = await list2.json()
    expect(list2Data.instances[0].status).toBe('online')

    // Step 9: Request-connect returns already_connected
    const rc2 = await app.request(`/api/instances/${instanceId}/request-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const rc2Data = await rc2.json()
    expect(rc2Data.status).toBe('already_connected')

    // Step 10: WebSocket closes (remove from tunnels)
    _testing.tunnels.delete(instanceId)

    // Step 11: Instance list goes back to heartbeat (recently seen)
    const list3 = await app.request('/api/instances?workspaceId=ws-e2e')
    const list3Data = await list3.json()
    expect(list3Data.instances[0].status).toBe('heartbeat')
  })

  test('instance heartbeat with metadata persists across calls', async () => {
    const app = createTestApp()

    await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'shogo_e2e_key' },
      body: JSON.stringify({
        hostname: 'meta-test',
        name: 'Meta Test',
        os: 'linux',
        arch: 'x64',
        metadata: { activeProjects: 5, customField: 'hello' },
      }),
    })

    const hb2 = await app.request('/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'shogo_e2e_key' },
      body: JSON.stringify({
        hostname: 'meta-test',
        metadata: { activeProjects: 3 },
      }),
    })

    expect(hb2.status).toBe(200)
    const inst = [...instancesById.values()].find((i: any) => i.hostname === 'meta-test') as any
    expect(inst).toBeTruthy()
    expect(inst.metadata.activeProjects).toBe(3)
  })
})
