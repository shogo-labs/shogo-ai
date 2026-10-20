// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `/api/machines` — a paired desktop's own workspaces, owner-only.
 *
 * Covers the three new routes end to end against the real tunnel framing
 * (`_testing.tunnels` holds a fake WebSocket, so `sendTunnelRequest` /
 * `sendTunnelStreamRequest` run unmodified):
 *   - the owner sees the machine, another member of the same cloud workspace
 *     sees nothing and is refused on every route,
 *   - the snapshot relay serves fresh data when the tunnel is up and the
 *     cached heartbeat snapshot flagged `stale` when it is not,
 *   - an unreachable machine answers `503 {code:'offline'}` — never `200 []`,
 *   - the workspace relay forwards the desktop's own `/api/*` path with the
 *     cloud identity translated into `x-tunnel-auth-*` and the local
 *     workspace id stamped on the request.
 *
 *   bun test apps/api/src/__tests__/machines-routes.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'

type Instance = {
  id: string
  workspaceId: string
  userId: string | null
  hostname: string
  name: string
  os: string | null
  arch: string | null
  kind: string
  lastSeenAt: Date | null
  metadata: any
  wsRequestedAt: Date | null
}

const instancesById = new Map<string, Instance>()
const auditRows: any[] = []

const mockPrisma = {
  instance: {
    findUnique: async (args: any) => {
      const inst = instancesById.get(args.where.id)
      return inst ? { ...inst } : null
    },
    findMany: async (args: any) => {
      const where = args?.where ?? {}
      return [...instancesById.values()]
        .filter((i) => (where.userId === undefined ? true : i.userId === where.userId))
        .map((i) => ({ ...i }))
    },
    update: async (args: any) => {
      const inst = instancesById.get(args.where.id)
      if (!inst) throw new Error('not found')
      Object.assign(inst, args.data)
      return { ...inst }
    },
  },
  remoteAction: {
    create: async (args: any) => {
      auditRows.push(args.data)
      return args.data
    },
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: async () => null,
}))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => {},
  sendPushToUser: async () => {},
}))

const { machineRoutes, _testing: machineTesting } = await import('../routes/machines')
const { _testing: instanceTesting } = await import('../routes/instances')

const OWNER = { id: 'u-1', userId: 'u-1', email: 'owner@x', name: 'Owner', role: 'member' }
const OTHER_MEMBER = { id: 'u-2', userId: 'u-2', email: 'other@x', name: 'Other', role: 'member' }

let currentAuth: any = OWNER

function buildApp(auth: any = OWNER) {
  currentAuth = auth
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', currentAuth)
    await next()
  })
  app.route('/api', machineRoutes())
  return app
}

function seedInstance(overrides: Partial<Instance> = {}): Instance {
  const inst: Instance = {
    id: 'i-1',
    workspaceId: 'ws-cloud',
    userId: 'u-1',
    hostname: 'mac',
    name: 'Russell’s Mac',
    os: 'darwin',
    arch: 'arm64',
    kind: 'desktop',
    lastSeenAt: new Date(),
    metadata: {},
    wsRequestedAt: null,
    ...overrides,
  }
  instancesById.set(inst.id, inst)
  return inst
}

type FakeTunnel = {
  ws: { send: (raw: string) => void }
  instanceId: string
  workspaceId: string
  pendingRequests: Map<string, any>
  streamHandlers: Map<string, (chunk: any) => void>
}

/**
 * Register a fake desktop: every request frame the cloud writes is answered
 * straight away with `handler`'s response, so the relay code paths are
 * exercised for real (including the streaming handshake).
 */
function attachTunnel(
  instanceId: string,
  handler: (req: any, conn: FakeTunnel) => void,
): FakeTunnel {
  const conn: FakeTunnel = {
    ws: {
      send: (raw: string) => {
        const frame = JSON.parse(raw)
        handler(frame, conn)
      },
    },
    instanceId,
    workspaceId: 'ws-cloud',
    pendingRequests: new Map(),
    streamHandlers: new Map(),
  }
  instanceTesting.tunnels.set(instanceId, conn as any)
  return conn
}

function respondJson(payload: unknown, status = 200) {
  return (req: any, conn: FakeTunnel) => {
    conn.pendingRequests.get(req.requestId)?.resolve({
      type: 'response',
      requestId: req.requestId,
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }
}

const SNAPSHOT = {
  machine: { id: 'device-1', name: 'Russell’s Mac', hostname: 'mac', os: 'darwin', arch: 'arm64' },
  workspaces: [
    { id: 'lw-1', name: 'Personal', kind: 'personal', projectCount: 3, lastActivityAt: '2026-10-19T10:00:00.000Z' },
  ],
  activity: { runningTurns: 1, runningTasks: 0, chats: 4, lastActivityAt: '2026-10-19T10:00:00.000Z' },
  generatedAt: '2026-10-19T10:00:00.000Z',
}

beforeEach(() => {
  instancesById.clear()
  auditRows.length = 0
  instanceTesting.tunnels.clear()
  instanceTesting.activeViewers.clear()
  machineTesting.resetWakeDeadlineMs()
  machineTesting.setWakeDeadlineMs(120)
})

// ────────────────────────────────────────────────────────────────────
// GET /api/machines
// ────────────────────────────────────────────────────────────────────

describe('GET /api/machines', () => {
  test('returns the caller’s own machine', async () => {
    seedInstance()
    const res = await buildApp().request('/api/machines')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.machines).toHaveLength(1)
    expect(body.machines[0]).toMatchObject({
      id: 'i-1',
      name: 'Russell’s Mac',
      kind: 'desktop',
      status: 'heartbeat',
    })
  })

  test('a second member of the same cloud workspace gets an empty list', async () => {
    seedInstance({ userId: 'u-1' })
    const res = await buildApp(OTHER_MEMBER).request('/api/machines')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.machines).toEqual([])
  })

  test('401 without an authenticated user', async () => {
    seedInstance()
    const res = await buildApp({}).request('/api/machines')
    expect(res.status).toBe(401)
  })

  test('carries the cached heartbeat snapshot so an offline row can still render', async () => {
    seedInstance({ lastSeenAt: new Date(Date.now() - 60 * 60 * 1000), metadata: { machine: SNAPSHOT } })
    const res = await buildApp().request('/api/machines')
    const body = (await res.json()) as any
    expect(body.machines[0].status).toBe('offline')
    expect(body.machines[0].snapshot.workspaces[0].id).toBe('lw-1')
  })
})

// ────────────────────────────────────────────────────────────────────
// GET /api/machines/:id/workspaces
// ────────────────────────────────────────────────────────────────────

describe('GET /api/machines/:id/workspaces', () => {
  test('relays /api/local/machine through the tunnel and returns its workspaces', async () => {
    seedInstance()
    let seenPath: string | undefined
    let seenUserHeader: string | undefined
    attachTunnel('i-1', (req, conn) => {
      seenPath = req.path
      seenUserHeader = req.headers?.['x-tunnel-auth-user-id']
      respondJson(SNAPSHOT)(req, conn)
    })

    const res = await buildApp().request('/api/machines/i-1/workspaces')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(seenPath).toBe('/api/local/machine')
    expect(seenUserHeader).toBe('u-1')
    expect(body.stale).toBe(false)
    expect(body.machine.id).toBe('i-1')
    expect(body.machine.id).not.toBe('device-1')
    expect(body.workspaces.map((w: any) => w.id)).toEqual(['lw-1'])
  })

  test('another member of the same workspace is refused with 403', async () => {
    seedInstance()
    const res = await buildApp(OTHER_MEMBER).request('/api/machines/i-1/workspaces')
    expect(res.status).toBe(403)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('forbidden')
  })

  test('serves the cached snapshot flagged stale when the machine is offline', async () => {
    seedInstance({
      lastSeenAt: new Date(Date.now() - 60 * 60 * 1000),
      metadata: { machine: SNAPSHOT },
    })
    const res = await buildApp().request('/api/machines/i-1/workspaces')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.stale).toBe(true)
    expect(body.status).toBe('offline')
    expect(body.workspaces[0].id).toBe('lw-1')
  })

  test('503 offline when the machine is unreachable and was never seen', async () => {
    seedInstance({ lastSeenAt: null, metadata: {} })
    const res = await buildApp().request('/api/machines/i-1/workspaces')
    expect(res.status).toBe(503)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('offline')
  })

  test('404 for an unknown machine', async () => {
    const res = await buildApp().request('/api/machines/nope/workspaces')
    expect(res.status).toBe(404)
  })
})

// ────────────────────────────────────────────────────────────────────
// ALL /api/machines/:id/w/:localWorkspaceId/*
// ────────────────────────────────────────────────────────────────────

describe('machine workspace relay', () => {
  test('forwards the desktop path with translated identity and local workspace id', async () => {
    seedInstance()
    let seen: any
    attachTunnel('i-1', (req, conn) => {
      seen = req
      conn.pendingRequests.get(req.requestId)?.resolve({
        type: 'response',
        requestId: req.requestId,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projects: [{ id: 'p-1' }] }),
      })
    })

    const res = await buildApp().request('/api/machines/i-1/w/lw-1/projects?includeHidden=true')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.projects[0].id).toBe('p-1')
    expect(seen.path).toBe('/api/projects?includeHidden=true')
    expect(seen.method).toBe('GET')
    expect(seen.headers['x-tunnel-auth-user-id']).toBe('u-1')
    expect(auditRows.at(-1)).toMatchObject({ instanceId: 'i-1', path: 'lw-1:/api/projects?includeHidden=true' })
  })

  test('POST body reaches the desktop', async () => {
    seedInstance()
    let seen: any
    attachTunnel('i-1', (req, conn) => {
      seen = req
      respondJson({ id: 'msg-1' })(req, conn)
    })

    const res = await buildApp().request('/api/machines/i-1/w/lw-1/chat-messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(seen.body)).toEqual({ content: 'hello' })
    expect(seen.method).toBe('POST')
  })

  test('a second member of the cloud workspace is refused with 403', async () => {
    seedInstance()
    attachTunnel('i-1', respondJson({}))
    const res = await buildApp(OTHER_MEMBER).request('/api/machines/i-1/w/lw-1/projects')
    expect(res.status).toBe(403)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('forbidden')
  })

  test('an offline machine answers 503 offline, never 200 with empty data', async () => {
    seedInstance({ lastSeenAt: null, metadata: { machine: SNAPSHOT } })
    const res = await buildApp().request('/api/machines/i-1/w/lw-1/projects')
    expect(res.status).toBe(503)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('offline')
    expect(body.projects).toBeUndefined()
  })

  test('streams an agent chat SSE back through the relay', async () => {
    seedInstance()
    let frame: any
    attachTunnel('i-1', (req, conn) => {
      frame = req
      const send = conn.streamHandlers.get(req.requestId)
      send?.({ type: 'stream-chunk', requestId: req.requestId, data: '{"delta":"hi"}' })
      send?.({ type: 'stream-end', requestId: req.requestId })
    })

    const res = await buildApp().request(
      '/api/machines/i-1/w/lw-1/projects/p-1/agent-proxy/agent/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toBe('{"delta":"hi"}')
    // The desktop gets the full desktop path, not the cloud's cloud-shaped one.
    expect(frame.path).toBe('/api/projects/p-1/agent-proxy/agent/chat')
  })
})
