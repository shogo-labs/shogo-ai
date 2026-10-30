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
import { createRemoteAwareHttpClient } from '../../../../packages/shared-app/src/services/remote-http-interceptor'

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
let syncStateRow:
  | { instanceId: string; enabled: boolean; lastIngestAt: Date | null; cursor?: number }
  | null = null

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
        .filter((i) => (where.kind?.not === undefined ? true : i.kind !== where.kind.not))
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
  machineSyncState: {
    findUnique: async (args: any) => {
      if (!syncStateRow) return null
      return args?.where?.instanceId === syncStateRow.instanceId ? { ...syncStateRow } : null
    },
    findMany: async () => (syncStateRow ? [{ ...syncStateRow }] : []),
    upsert: async (args: any) => {
      syncStateRow = {
        instanceId: args.where.instanceId,
        enabled: true,
        lastIngestAt: null,
        ...(syncStateRow ? syncStateRow : args.create),
        ...args.update,
      }
      return { ...syncStateRow }
    },
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: async (key: string) =>
    key === 'shogo_sk_device' ? { userId: 'u-1', workspaceId: 'ws-cloud' } : null,
}))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => {},
  sendPushToUser: async () => {},
}))

const { machineRoutes, _testing: machineTesting } = await import('../routes/machines')
const { _testing: instanceTesting } = await import('../routes/instances')
const machineIdentity = await import('../lib/machine-identity')

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
  syncStateRow = null
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

  // PERF-6: every open Studio tab polls this list. Marking the viewer here put
  // all of the caller's desktops on the 5 s heartbeat whenever a tab was open.
  test('listing machines does not put them on the fast viewer poll', async () => {
    seedInstance({ id: 'i-1', workspaceId: 'ws-a' })
    seedInstance({ id: 'i-2', workspaceId: 'ws-b', hostname: 'mac-2' })
    const res = await buildApp().request('/api/machines')
    expect(res.status).toBe(200)
    expect(instanceTesting.activeViewers.size).toBe(0)
    expect(await instanceTesting.isViewerActive('ws-a')).toBe(false)
    expect(await instanceTesting.isViewerActive('ws-b')).toBe(false)
  })

  test('carries the cached heartbeat snapshot so an offline row can still render', async () => {
    seedInstance({ lastSeenAt: new Date(Date.now() - 60 * 60 * 1000), metadata: { machine: SNAPSHOT } })
    const res = await buildApp().request('/api/machines')
    const body = (await res.json()) as any
    expect(body.machines[0].status).toBe('offline')
    expect(body.machines[0].snapshot.workspaces[0].id).toBe('lw-1')
  })

  // SHO-120: a `shogo worker` VM serves `/agent/*` and no data API, so it has no
  // workspaces to offer. It stays in Settings → Remote control
  // (`GET /instances?scope=owner`), never in the workspace switcher.
  test('does not offer a cli-worker as a machine', async () => {
    seedInstance({ id: 'i-mac', name: 'Russell’s Mac' })
    seedInstance({ id: 'i-vm', kind: 'cli_worker', hostname: 'vm', name: 'Dev VM' })
    const res = await buildApp().request('/api/machines')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.machines.map((m: any) => m.id)).toEqual(['i-mac'])
  })
})

// ────────────────────────────────────────────────────────────────────
// A cli-worker is an execution target, not a machine (SHO-120)
// ────────────────────────────────────────────────────────────────────

describe('a cli-worker is refused by the machine routes', () => {
  test('the workspace snapshot answers 409 not_a_machine, not the VM’s 502', async () => {
    seedInstance({ kind: 'cli_worker' })
    let tunnelTouched = false
    attachTunnel('i-1', () => {
      tunnelTouched = true
    })

    const res = await buildApp().request('/api/machines/i-1/workspaces')
    expect(res.status).toBe(409)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('not_a_machine')
    expect(tunnelTouched).toBe(false)
  })

  test('a workspace data call answers 409 not_a_machine instead of forwarding it', async () => {
    seedInstance({ kind: 'cli_worker' })
    let tunnelTouched = false
    attachTunnel('i-1', () => {
      tunnelTouched = true
    })

    const res = await buildApp().request(
      '/api/machines/i-1/w/lw-1/api/projects/p-1/agent-proxy/agent/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('not_a_machine')
    expect(body.error.message).toContain('/api/instances/:id/p')
    expect(tunnelTouched).toBe(false)
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

    const res = await buildApp().request('/api/machines/i-1/w/lw-1/api/projects?includeHidden=true')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.projects[0].id).toBe('p-1')
    expect(seen.path).toBe('/api/projects?includeHidden=true')
    expect(seen.method).toBe('GET')
    expect(seen.headers['x-tunnel-auth-user-id']).toBe('u-1')
    expect(auditRows.at(-1)).toMatchObject({ instanceId: 'i-1', path: 'lw-1:/api/projects?includeHidden=true' })
  })

  test("the owner is one person: the machine's local id goes out, the cloud id comes back", async () => {
    machineIdentity._resetMachineIdentityForTests()
    seedInstance()
    const seen: any[] = []
    attachTunnel('i-1', (req, conn) => {
      seen.push(req)
      conn.pendingRequests.get(req.requestId)?.resolve({
        type: 'response',
        requestId: req.requestId,
        status: 200,
        headers: { 'content-type': 'application/json', 'x-shogo-local-user-id': 'local-1' },
        body: JSON.stringify({ conversation: { id: 'dm-1', createdBy: 'local-1', members: [{ userId: 'local-1' }] } }),
      })
    })

    // First contact: the desktop names its owner on the reply.
    const first = await buildApp().request('/api/machines/i-1/w/lw-1/api/workspaces/lw-1/dms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { projectId: null } }),
    })
    expect(first.headers.get('x-shogo-local-user-id')).toBeNull()
    expect(await first.json()).toEqual({ conversation: { id: 'dm-1', createdBy: 'u-1', members: [{ userId: 'u-1' }] } })

    // From then on what the client sends in its cloud id reaches the machine in its local one.
    await buildApp().request('/api/machines/i-1/w/lw-1/api/workspaces/lw-1/dms?as=u-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userIds: ['u-1'] }),
    })
    expect(seen[1].path).toBe('/api/workspaces/lw-1/dms?as=local-1')
    expect(JSON.parse(seen[1].body)).toEqual({ userIds: ['local-1'] })
    expect(seen[1].headers['x-tunnel-auth-user-id']).toBe('u-1')
  })

  test('POST body reaches the desktop', async () => {
    seedInstance()
    let seen: any
    attachTunnel('i-1', (req, conn) => {
      seen = req
      respondJson({ id: 'msg-1' })(req, conn)
    })

    const res = await buildApp().request('/api/machines/i-1/w/lw-1/api/chat-messages', {
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
    const res = await buildApp(OTHER_MEMBER).request('/api/machines/i-1/w/lw-1/api/projects')
    expect(res.status).toBe(403)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('forbidden')
    expect(instanceTesting.activeViewers.size).toBe(0)
  })

  // PERF-6 keeps SHO-185's goal for the machine actually in use: using one of
  // its workspaces keeps that desktop on the 5 s poll, and only that one.
  test('using a machine workspace marks only that machine as viewed', async () => {
    seedInstance({ id: 'i-1', workspaceId: 'ws-a' })
    seedInstance({ id: 'i-2', workspaceId: 'ws-b', hostname: 'mac-2' })
    attachTunnel('i-1', respondJson({ projects: [] }))
    const res = await buildApp().request('/api/machines/i-1/w/lw-1/api/projects')
    expect(res.status).toBe(200)
    expect(await instanceTesting.isViewerActive('ws-a')).toBe(true)
    expect(await instanceTesting.isViewerActive('ws-b')).toBe(false)
  })

  test('a sleeping machine in use is marked too, so its next heartbeat comes fast', async () => {
    seedInstance({ workspaceId: 'ws-a', lastSeenAt: new Date(Date.now() - 20_000) })
    const res = await buildApp().request('/api/machines/i-1/w/lw-1/api/projects')
    expect(res.status).toBe(503)
    expect(await instanceTesting.isViewerActive('ws-a')).toBe(true)
  })

  test('a machine that heartbeated recently is `waking`, not `offline`', async () => {
    // An idle desktop signals every 60s and has no push channel, so "no tunnel
    // right now" is normal for a live machine. Saying offline there is what made
    // every panel of a sleeping machine's workspace fail (SHO-185).
    seedInstance({ lastSeenAt: new Date(Date.now() - 20_000), metadata: { machine: SNAPSHOT } })
    const res = await buildApp().request('/api/machines/i-1/w/lw-1/api/projects')
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('3')
    const body = (await res.json()) as any
    expect(body.error.code).toBe('waking')
    expect(body.projects).toBeUndefined()
  })

  test('an offline machine answers 503 offline, never 200 with empty data', async () => {
    seedInstance({ lastSeenAt: null, metadata: { machine: SNAPSHOT } })
    const res = await buildApp().request('/api/machines/i-1/w/lw-1/api/projects')
    expect(res.status).toBe(503)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('offline')
    expect(body.projects).toBeUndefined()
  })

  test('a write to an offline machine is read-only, not a retry', async () => {
    // The rows are on the desktop, so a write has nowhere to land. Answering
    // `waking` here would make the composer retry a send that can never be
    // delivered, and the client would queue nothing to show for it (SHO-185).
    seedInstance({ lastSeenAt: null, metadata: { machine: SNAPSHOT } })
    syncStateRow = {
      instanceId: 'i-1',
      enabled: true,
      lastIngestAt: new Date('2026-10-23T09:00:00.000Z'),
    }

    const res = await buildApp().request('/api/machines/i-1/w/lw-1/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Docs' }),
    })

    expect(res.status).toBe(409)
    expect(res.headers.get('retry-after')).toBeNull()
    const body = (await res.json()) as any
    expect(body.error.code).toBe('machine_offline_readonly')
    // What the banner shows: the copy's last successful ingest.
    expect(body.error.lastSyncedAt).toBe('2026-10-23T09:00:00.000Z')
  })

  test('a live read of an offline machine still says offline', async () => {
    // Preview, terminal and file contents are not in the copy — they are the
    // machine. There is nothing to be read-only about, so no 409.
    seedInstance({ lastSeenAt: null, metadata: { machine: SNAPSHOT } })
    const res = await buildApp().request('/api/machines/i-1/w/lw-1/api/workspaces/ws-1/preview')
    expect(res.status).toBe(503)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('offline')
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
      '/api/machines/i-1/w/lw-1/api/projects/p-1/agent-proxy/agent/chat',
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

  // A workspace agent turn (the personal companion, or a paired desktop's own
  // workspace) is the same SSE surface. Before SHO-87 the workspace wrapper was
  // not normalized, so this took the buffered branch and the turn only arrived
  // when it ended — or never.
  test('streams a workspace agent chat SSE back through the relay', async () => {
    seedInstance()
    let frame: any
    attachTunnel('i-1', (req, conn) => {
      frame = req
      const send = conn.streamHandlers.get(req.requestId)
      send?.({ type: 'stream-chunk', requestId: req.requestId, data: '{"delta":"hello"}' })
      send?.({ type: 'stream-end', requestId: req.requestId })
    })

    const res = await buildApp().request(
      '/api/machines/i-1/w/lw-1/api/workspaces/lw-1/agent-proxy/agent/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toBe('{"delta":"hello"}')
    expect(frame.path).toBe('/api/workspaces/lw-1/agent-proxy/agent/chat')
  })

  // SHO-120 seam: the interceptor appends the *client* path (`/api/projects`) to
  // the relay base, so the relay must forward that exact suffix. Two unit tests
  // used to cover the halves separately and never met: one posted `/w/lw-1/projects`,
  // the other asserted the app's doubled `/api/api/projects`. Composing them here
  // is the only thing that catches a re-introduced double prefix.
  test('a data call built by the app reaches the desktop as a single /api path', async () => {
    seedInstance()
    let seen: any
    attachTunnel('i-1', (req, conn) => {
      seen = req
      respondJson({ projects: [{ id: 'p-1' }] })(req, conn)
    })

    const calls: Array<{ path: string; body?: unknown }> = []
    const http = {
      get: async (path: string) => {
        calls.push({ path })
        return { data: {} }
      },
      post: async (path: string, body?: unknown) => {
        calls.push({ path, body })
        return { data: {} }
      },
      patch: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
      request: async () => ({ data: {} }),
    } as any

    // `remoteProxyBaseUrl` is exactly what `computeRemoteProxyBaseUrl` hands
    // `SDKDomainProvider` for a machine workspace.
    const proxy = createRemoteAwareHttpClient(http, () => ({
      remoteProxyBaseUrl: 'https://studio.shogo.ai/api/machines/i-1/w/lw-1',
      machineWorkspaceId: 'lw-1',
    }))
    // A write — a read of the machine's records is answered by the cloud copy
    // and never reaches the relay (SHO-185).
    await proxy.post('/api/projects', { name: 'Docs', workspaceId: 'ws-cloud' })

    // The URL the app would fetch, replayed through the real relay route.
    const sent = new URL(calls[0].path)
    const res = await buildApp().request(`${sent.pathname}${sent.search}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(calls[0].body),
    })

    expect(res.status).toBe(200)
    expect(seen.path).toBe('/api/projects')
    expect(seen.path.startsWith('/api/api')).toBe(false)
    // A create carries the workspace in its body, and it must be the machine's
    // own id — the cloud id the UI was showing resolves to nothing there.
    expect(JSON.parse(seen.body).workspaceId).toBe('lw-1')
  })
})

// ────────────────────────────────────────────────────────────────────
// POST /api/machines/:id/sync — device-key auth (PERF-9)
// ────────────────────────────────────────────────────────────────────

describe('POST /api/machines/:id/sync auth', () => {
  function push(app: Hono, headers: Record<string, string>) {
    return app.request('/api/machines/i-1/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ mode: 'changes', epoch: 'e', cursor: 0, models: [] }),
    })
  }

  test('a desktop that sends its key as x-api-key (builds before the fix) is accepted', async () => {
    seedInstance()
    syncStateRow = { instanceId: 'i-1', enabled: false, lastIngestAt: null, cursor: 7 }
    const res = await push(buildApp(null), { 'x-api-key': 'shogo_sk_device' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, disabled: true, cursor: 7 })
  })

  test('an unknown x-api-key is still refused with 401', async () => {
    seedInstance()
    const res = await push(buildApp(null), { 'x-api-key': 'shogo_sk_wrong' })
    expect(res.status).toBe(401)
  })

  test('a person’s session is not a device key', async () => {
    seedInstance()
    const res = await push(buildApp({ ...OWNER, workspaceId: 'ws-cloud', via: 'session' }), {})
    expect(res.status).toBe(401)
  })
})
