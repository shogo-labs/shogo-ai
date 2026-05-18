// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `apps/api/src/routes/instances.ts` — auth + validation + branch coverage.
 *
 * The existing `instances-e2e.test.ts` covers the happy-path E2E flow
 * (heartbeat → viewer-active → request-connect → session). This file
 * targets the remaining 50% of `routes/instances.ts` by exercising
 * every auth + validation failure branch on the REST handlers, plus
 * the read-only happy paths for the list + detail endpoints.
 *
 *   bun test apps/api/src/__tests__/instances-routes.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'

// ────────────────────────────────────────────────────────────────────
// In-memory Prisma
// ────────────────────────────────────────────────────────────────────
type Instance = {
  id: string
  workspaceId: string
  hostname: string
  name: string
  os: string | null
  arch: string | null
  lastSeenAt: Date
  metadata: any
  wsRequestedAt: Date | null
  createdAt: Date
  updatedAt: Date
}
const instancesById = new Map<string, Instance>()
const membersByUserWs = new Map<string, { id: string; userId: string; workspaceId: string }>()

const memberKey = (userId: string, workspaceId: string) => `${userId}::${workspaceId}`

const mockPrisma = {
  instance: {
    findUnique: async (args: any) => {
      const inst = instancesById.get(args.where.id)
      return inst ? { ...inst } : null
    },
    findMany: async (args: any) =>
      [...instancesById.values()].filter((i) => i.workspaceId === args.where.workspaceId),
    upsert: async (args: any) => {
      const key = `${args.where.workspaceId_hostname.workspaceId}::${args.where.workspaceId_hostname.hostname}`
      for (const inst of instancesById.values()) {
        if (`${inst.workspaceId}::${inst.hostname}` === key) {
          Object.assign(inst, args.update, { updatedAt: new Date() })
          return { ...inst }
        }
      }
      const created: Instance = {
        id: `inst-${instancesById.size + 1}`,
        ...args.create,
        wsRequestedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      instancesById.set(created.id, created)
      return { ...created }
    },
    update: async (args: any) => {
      const inst = instancesById.get(args.where.id)
      if (!inst) throw new Error('not found')
      Object.assign(inst, args.data, { updatedAt: new Date() })
      return { ...inst }
    },
    delete: async (args: any) => {
      const inst = instancesById.get(args.where.id)
      if (!inst) throw new Error('not found')
      instancesById.delete(args.where.id)
      return inst
    },
  },
  member: {
    findFirst: async (args: any) => membersByUserWs.get(memberKey(args.where.userId, args.where.workspaceId)) ?? null,
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))

mock.module('../routes/api-keys', () => ({
  resolveApiKey: async (key: string) => (key === 'good-key' ? { workspaceId: 'ws-1', userId: 'u-1' } : null),
}))

mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => {},
}))

const { instanceRoutes, _testing } = await import('../routes/instances')

const auth = { id: 'u-1', userId: 'u-1', email: 'u@x', role: 'super_admin' }

function buildApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    ;(c as any).set('auth', auth)
    await next()
  })
  app.route('/api', instanceRoutes())
  return app
}

function noAuthApp() {
  const app = new Hono()
  app.route('/api', instanceRoutes())
  return app
}

beforeEach(() => {
  instancesById.clear()
  membersByUserWs.clear()
  _testing.tunnels.clear()
  _testing.activeViewers.clear()
})

function seedInstance(overrides: Partial<Instance> = {}): Instance {
  const inst: Instance = {
    id: 'i-1',
    workspaceId: 'ws-1',
    hostname: 'mac',
    name: 'mac',
    os: 'darwin',
    arch: 'arm64',
    lastSeenAt: new Date(),
    metadata: {},
    wsRequestedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
  instancesById.set(inst.id, inst)
  return inst
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('POST /instances/heartbeat', () => {
  test('401 when no x-api-key header is sent', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/instances/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostname: 'mac' }),
    }))
    expect(res.status).toBe(401)
  })

  test('401 when the api key cannot be resolved', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'bad' },
      body: JSON.stringify({ hostname: 'mac' }),
    }))
    expect(res.status).toBe(401)
  })

  test('400 when hostname is missing from body', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'good-key' },
      body: JSON.stringify({ name: 'no-hostname' }),
    }))
    expect(res.status).toBe(400)
  })

  test('200 happy path inserts a new instance and returns nextPollIn', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/instances/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'good-key' },
      body: JSON.stringify({ hostname: 'mac', name: 'My Mac', os: 'darwin', arch: 'arm64' }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.instanceId).toBeDefined()
    expect(typeof body.nextPollIn).toBe('number')
    expect(body.tunnelStatus === 'polling' || body.tunnelStatus === 'connected').toBe(true)
  })
})

describe('POST /instances/viewer-active', () => {
  test('401 when unauthenticated', async () => {
    const app = noAuthApp()
    const res = await app.fetch(new Request('http://x/api/instances/viewer-active', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: 'ws-1' }),
    }))
    expect(res.status).toBe(401)
  })

  test('400 when workspaceId is omitted', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/instances/viewer-active', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    }))
    expect(res.status).toBe(400)
  })

  test('403 when caller is not a member of the workspace', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/instances/viewer-active', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: 'ws-1' }),
    }))
    expect(res.status).toBe(403)
  })

  test('200 when caller is a workspace member', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/instances/viewer-active', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: 'ws-1' }),
    }))
    expect(res.status).toBe(200)
  })
})

describe('GET /instances', () => {
  test('401 unauthenticated', async () => {
    const res = await noAuthApp().fetch(new Request('http://x/api/instances?workspaceId=ws-1'))
    expect(res.status).toBe(401)
  })

  test('400 when workspaceId query param is missing', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/instances'))
    expect(res.status).toBe(400)
  })

  test('403 when caller is not a workspace member', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/instances?workspaceId=ws-1'))
    expect(res.status).toBe(403)
  })

  test('200 returns instances + computed status', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances?workspaceId=ws-1'))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.instances).toHaveLength(1)
    expect(body.instances[0].status).toBeDefined()
  })
})

describe('GET /instances/online', () => {
  test('400 when workspaceId is missing', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/instances/online'))
    expect(res.status).toBe(400)
  })

  test('403 when caller is not a workspace member', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/instances/online?workspaceId=ws-1'))
    expect(res.status).toBe(403)
  })

  test('200 returns only online instances (none in local-mode test)', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/online?workspaceId=ws-1'))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(Array.isArray(body.instances)).toBe(true)
    expect(body.instances).toHaveLength(0)
  })
})

describe('GET /instances/:id', () => {
  test('401 unauthenticated', async () => {
    const res = await noAuthApp().fetch(new Request('http://x/api/instances/i-1'))
    expect(res.status).toBe(401)
  })

  test('404 when the instance is unknown', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/instances/missing'))
    expect(res.status).toBe(404)
  })

  test('403 when caller is not a workspace member', async () => {
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1'))
    expect(res.status).toBe(403)
  })

  test('200 returns instance details + controllers list', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1'))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.id).toBe('i-1')
    expect(Array.isArray(body.controllers)).toBe(true)
  })
})

describe('PUT /instances/:id', () => {
  test('401 unauthenticated', async () => {
    const res = await noAuthApp().fetch(new Request('http://x/api/instances/i-1', {
      method: 'PUT', body: JSON.stringify({ name: 'x' }),
    }))
    expect(res.status).toBe(401)
  })

  test('404 when missing', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/instances/missing', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    }))
    expect(res.status).toBe(404)
  })

  test('403 when not a workspace member', async () => {
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    }))
    expect(res.status).toBe(403)
  })

  test('200 renames instance', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New Name' }),
    }))
    expect(res.status).toBe(200)
    expect(instancesById.get('i-1')?.name).toBe('New Name')
  })
})

describe('DELETE /instances/:id', () => {
  test('401 unauthenticated', async () => {
    const res = await noAuthApp().fetch(new Request('http://x/api/instances/i-1', { method: 'DELETE' }))
    expect(res.status).toBe(401)
  })

  test('404 when missing', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/instances/missing', { method: 'DELETE' }))
    expect(res.status).toBe(404)
  })

  test('403 when not a workspace member', async () => {
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1', { method: 'DELETE' }))
    expect(res.status).toBe(403)
  })

  test('200 removes the instance from the registry', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1', { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(instancesById.has('i-1')).toBe(false)
  })
})

describe('POST /instances/:id/request-connect', () => {
  test('401 unauthenticated', async () => {
    const res = await noAuthApp().fetch(new Request('http://x/api/instances/i-1/request-connect', { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  test('404 when missing', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/instances/missing/request-connect', { method: 'POST' }))
    expect(res.status).toBe(404)
  })

  test('403 when not a workspace member', async () => {
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1/request-connect', { method: 'POST' }))
    expect(res.status).toBe(403)
  })

  test('200 marks wsRequestedAt and viewer active', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1/request-connect', { method: 'POST' }))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.status).toBe('requested')
    expect(instancesById.get('i-1')!.wsRequestedAt).not.toBeNull()
  })
})

describe('POST /instances/:id/proxy', () => {
  test('401 unauthenticated', async () => {
    const res = await noAuthApp().fetch(new Request('http://x/api/instances/i-1/proxy', {
      method: 'POST', body: JSON.stringify({ method: 'GET', path: '/' }),
    }))
    expect(res.status).toBe(401)
  })

  test('404 when missing', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/instances/missing/proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'GET', path: '/' }),
    }))
    expect(res.status).toBe(404)
  })

  test('403 when not a workspace member', async () => {
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1/proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'GET', path: '/' }),
    }))
    expect(res.status).toBe(403)
  })

  test('503 when the instance has no active tunnel', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1/proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'GET', path: '/' }),
    }))
    expect(res.status).toBe(503)
  })
})

describe('POST /instances/:id/ping', () => {
  test('401 unauthenticated', async () => {
    const res = await noAuthApp().fetch(new Request('http://x/api/instances/i-1/ping', { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  test('404 when missing', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/instances/missing/ping', { method: 'POST' }))
    expect(res.status).toBe(404)
  })

  test('503 when the instance has no active tunnel', async () => {
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1/ping', { method: 'POST' }))
    expect(res.status).toBe(503)
  })
})

describe('POST /instances/:id/proxy/stream', () => {
  test('401 unauthenticated', async () => {
    const res = await noAuthApp().fetch(new Request('http://x/api/instances/i-1/proxy/stream', { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  test('404 when missing', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/instances/missing/proxy/stream', { method: 'POST' }))
    expect(res.status).toBe(404)
  })

  test('403 when not a workspace member', async () => {
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1/proxy/stream', { method: 'POST' }))
    expect(res.status).toBe(403)
  })

  test('503 when the instance has no active tunnel', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedInstance()
    const res = await buildApp().fetch(new Request('http://x/api/instances/i-1/proxy/stream', { method: 'POST' }))
    expect(res.status).toBe(503)
  })
})
