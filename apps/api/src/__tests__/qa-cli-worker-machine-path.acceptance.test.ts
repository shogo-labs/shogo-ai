// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-120 QA acceptance — "a `shogo worker` VM is a runtime, not a machine".
 *
 * The card's user story is one sentence: messages sent from Shogo to a VM
 * installed with `shogo worker` never reach it. Three layers contributed, and
 * the dev's unit tests cover each half separately:
 *
 *   - `machines-routes.test.ts` proves the machine relay refuses a cli-worker
 *     and forwards a single `/api`, but with a hand-emulated Prisma `not`
 *     filter and one route set mounted;
 *   - `instance-tunnel-chat-persistence.test.ts` proves a cli-worker streams a
 *     turn through `/instances/:id/p`, with a different prisma double;
 *   - `workspace-entries.test.ts` proves the app drops it from the switcher.
 *
 * This file composes them the way production runs them — one `/api` app with
 * both route sets, one instance row, one tunnel — so the acceptance criteria are
 * proven together rather than half each:
 *
 *   AC1  `GET /api/machines` excludes the VM *and* `GET /api/instances?scope=owner`
 *        still lists it (Settings → Remote control is where it belongs), with the
 *        real Prisma `where` pinned (an `undefined` enum would filter nothing).
 *   AC2  the machine relay answers `409 not_a_machine` and never forwards, so the
 *        worker's own `502 CLI_WORKER_HAS_NO_DATA_API` cannot be what the user sees.
 *   AC4  the *same* row still streams a chat turn as a project runtime, and the
 *        worker sees `/agent/chat` — the one family it serves.
 *   AC3  a streaming call the app builds lands as a single `/api` path, so the
 *        desktop branch of the same fix cannot regress silently.
 *
 *   bun test ./apps/api/src/__tests__/qa-cli-worker-machine-path.acceptance.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'
import { createRemoteAwareHttpClient } from '../../../../packages/shared-app/src/services/remote-http-interceptor'

process.env.SHOGO_LOCAL_MODE = 'true'
// Federation would replace the owner-scoped list with a cloud call; the card is
// about the local row, and the pod shell exports this key.
delete process.env.SHOGO_API_KEY

const OWNER = { id: 'u-1', userId: 'u-1', email: 'owner@x', name: 'Owner', role: 'super_admin' }
const CLOUD_WORKSPACE = 'ws-cloud'
const PROJECT_ID = 'p-1'
const CHAT_SESSION_ID = 'sess-1'

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
  createdAt: Date
  updatedAt: Date
}

const instancesById = new Map<string, Instance>()
const instanceFindMany = mock(async (args: any) => {
  const where = args?.where ?? {}
  return [...instancesById.values()]
    .filter((i) => (where.userId === undefined ? true : i.userId === where.userId))
    .filter((i) => (where.workspaceId === undefined ? true : i.workspaceId === where.workspaceId))
    .filter((i) => (where.kind?.not === undefined ? true : i.kind !== where.kind.not))
    .map((i) => ({ ...i }))
})
const remoteActionCreate = mock(async (args: any) => args.data)

const mockPrisma = {
  instance: {
    findMany: instanceFindMany,
    findUnique: async (args: any) => {
      const inst = instancesById.get(args.where.id)
      return inst ? { ...inst } : null
    },
    update: async (args: any) => {
      const inst = instancesById.get(args.where.id)
      if (!inst) throw new Error('not found')
      Object.assign(inst, args.data)
      return { ...inst }
    },
    delete: async (args: any) => {
      const inst = instancesById.get(args.where.id)
      instancesById.delete(args.where.id)
      return inst
    },
  },
  member: {
    findFirst: async () => ({ id: 'm-1', userId: 'u-1', workspaceId: CLOUD_WORKSPACE }),
    findMany: async () => [{ role: 'member', projectId: null, isBillingAdmin: false }],
  },
  workspace: {
    findMany: async (args: any) =>
      (args?.where?.id?.in ?? []).map((id: string) => ({ id, name: `Workspace ${id}` })),
  },
  user: { findUnique: async () => ({ role: 'user' }) },
  localConfig: { findUnique: async () => null },
  // The tunneled chat path persists the assistant row on the cloud; the write is
  // not what this card is about, but the route calls it.
  chatMessage: {
    create: async (args: any) => ({ id: 'msg-1', ...args.data }),
    update: async (args: any) => ({ id: args?.where?.id ?? 'msg-1', ...args.data }),
  },
  chatSession: { findUnique: async () => ({ id: CHAT_SESSION_ID, workspaceId: CLOUD_WORKSPACE }) },
  project: {
    findUnique: async () => ({ id: PROJECT_ID, name: 'Tunneled', workspaceId: CLOUD_WORKSPACE }),
    update: async () => ({}),
  },
  toolCallLog: { createMany: async () => ({ count: 0 }) },
  remoteAction: { create: remoteActionCreate },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({ resolveApiKey: async () => null }))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => {},
  sendPushToUser: async () => {},
}))
mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => true,
}))

const { machineRoutes } = await import('../routes/machines')
const { instanceRoutes, _testing: instanceTesting, handleInstanceWsMessage } = await import(
  '../routes/instances'
)

/** One app, both route sets — the way `server.ts` mounts them. */
function buildApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', OWNER as any)
    await next()
  })
  app.route('/api', machineRoutes())
  app.route('/api', instanceRoutes())
  return app
}

function seedInstance(overrides: Partial<Instance> = {}): Instance {
  const inst: Instance = {
    id: 'i-1',
    workspaceId: CLOUD_WORKSPACE,
    userId: 'u-1',
    hostname: 'mac',
    name: 'Russell’s Mac',
    os: 'darwin',
    arch: 'arm64',
    kind: 'desktop',
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

type FakeTunnel = {
  ws: { send: (raw: string) => void; data?: any; readyState?: number }
  instanceId: string
  workspaceId: string
  pendingRequests: Map<string, any>
  streamHandlers: Map<string, (chunk: any) => void>
}

/**
 * A fake device tunnel. `handler` sees every request frame the cloud writes, so
 * each test can assert both what reached the device and what did not.
 */
function attachTunnel(
  instanceId: string,
  handler: (req: any, conn: FakeTunnel) => void,
): FakeTunnel {
  const conn: FakeTunnel = {
    ws: {
      send: (raw: string) => handler(JSON.parse(raw), conn),
      data: { instanceId, workspaceId: CLOUD_WORKSPACE, _lastPong: Date.now() },
      readyState: 1,
    },
    instanceId,
    workspaceId: CLOUD_WORKSPACE,
    pendingRequests: new Map(),
    streamHandlers: new Map(),
  }
  instanceTesting.tunnels.set(instanceId, conn as any)
  return conn
}

/**
 * What a `shogo worker` VM's RuntimeResolver actually serves
 * (`packages/shogo-worker/src/lib/runtime-manager.ts`): an `/agent/*` path with a
 * single active project. Everything else is its structured 502. Reproducing the
 * resolver here means a regression that sends the VM `/api/projects` fails this
 * test as the 502 the user reported, not as a silent pass.
 */
function workerResolver(req: any, conn: FakeTunnel) {
  if (!String(req.path ?? '').startsWith('/agent')) {
    conn.pendingRequests.get(req.requestId)?.resolve({
      type: 'response',
      requestId: req.requestId,
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: { code: 'CLI_WORKER_HAS_NO_DATA_API', message: `only /agent/*; tried ${req.path}` },
      }),
    })
    return
  }
  const send = conn.streamHandlers.get(req.requestId)
  for (const delta of ['hello from the ', 'worker']) {
    send?.({ type: 'stream-chunk', requestId: req.requestId, data: `data: {"type":"text-delta","delta":"${delta}"}\n` })
  }
  send?.({ type: 'stream-chunk', requestId: req.requestId, data: 'data: {"type":"data-turn-complete","data":{"status":"completed"}}\n' })
  send?.({ type: 'stream-end', requestId: req.requestId })
}

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

beforeEach(() => {
  instancesById.clear()
  instanceFindMany.mockClear()
  remoteActionCreate.mockClear()
  instanceTesting.tunnels.clear()
  instanceTesting.activeViewers.clear()
})

describe('SHO-120 — a shogo worker VM is a runtime, not a machine workspace', () => {
  test('AC1 · the switcher list drops it, Settings → Remote control keeps it', async () => {
    seedInstance({ id: 'i-mac', name: 'Russell’s Mac' })
    seedInstance({ id: 'i-vm', kind: 'cli_worker', hostname: 'vm', name: 'Dev VM' })

    const machinesRes = await buildApp().request('/api/machines')
    expect(machinesRes.status).toBe(200)
    const machines = (await machinesRes.json()) as any
    expect(machines.machines.map((m: any) => m.id)).toEqual(['i-mac'])

    // The dev's unit test emulates the `not` filter inside its Prisma double, so
    // it would still pass if the route dropped the clause or the enum import were
    // undefined (Prisma ignores undefined filters). Pin the query itself.
    expect(instanceFindMany.mock.calls.at(-1)?.[0]?.where).toEqual({
      userId: 'u-1',
      kind: { not: 'cli_worker' },
    })

    // …and the VM stays manageable: it is the row Settings → Remote control
    // lists, and the only place a user can see or revoke it.
    const ownerRes = await buildApp().request('/api/instances?scope=owner')
    expect(ownerRes.status).toBe(200)
    const owner = (await ownerRes.json()) as any
    expect(owner.instances.map((i: any) => i.id).sort()).toEqual(['i-mac', 'i-vm'])
    // The wire spelling the app's cli-worker guard compares against.
    expect(owner.instances.find((i: any) => i.id === 'i-vm').kind).toBe('cli-worker')
  })

  test('AC2 + AC4 · the same VM refuses the machine relay and still answers a chat turn', async () => {
    seedInstance({ id: 'i-vm', kind: 'cli_worker', hostname: 'vm', name: 'Dev VM' })

    const seen: string[] = []
    attachTunnel('i-vm', (req, conn) => {
      seen.push(req.path)
      workerResolver(req, conn)
    })

    // ── AC2: a stateful call through the machine relay never reaches the VM ──
    const relayed = await buildApp().request(
      '/api/machines/i-vm/w/lw-vm/api/workspaces/lw-vm/agent-proxy/agent/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      },
    )
    expect(relayed.status).toBe(409)
    const refusal = (await relayed.json()) as any
    expect(refusal.error.code).toBe('not_a_machine')
    expect(refusal.error.message).toContain('/api/instances/:id/p')
    // The user's symptom was the worker's own structured 502; it must be gone,
    // and nothing may have been written to the tunnel at all.
    expect(JSON.stringify(refusal)).not.toContain('CLI_WORKER_HAS_NO_DATA_API')
    expect(seen).toEqual([])

    // ── AC4: the same row, entered the way the app really reaches it ──
    const turn = await buildApp().request(
      `/api/instances/i-vm/p/api/projects/${PROJECT_ID}/agent-proxy/agent/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Chat-Session-Id': CHAT_SESSION_ID },
        body: JSON.stringify({ chatSessionId: CHAT_SESSION_ID, messages: [{ role: 'user', content: 'hi' }] }),
      },
    )
    expect(turn.status).toBe(200)
    expect(turn.headers.get('content-type')).toBe('text/event-stream')
    // The SDK splits a turn across text-delta frames, so each delta is asserted
    // separately (a joined-string check would pass on a reordered stream too).
    const body = await drain(turn)
    expect(body).toContain('hello from the ')
    expect(body).toContain('"delta":"worker"')
    expect(body).toContain('data-turn-complete')
    // `/agent/chat` exactly — the only family a cli-worker's resolver serves.
    expect(seen).toEqual(['/agent/chat'])
  })

  test('AC3 · a streaming call the app builds lands as one /api path, not /api/api', async () => {
    seedInstance({ id: 'i-mac' })
    let frame: any
    attachTunnel('i-mac', (req, conn) => {
      frame = req
      const send = conn.streamHandlers.get(req.requestId)
      send?.({ type: 'stream-chunk', requestId: req.requestId, data: 'data: {"type":"text-delta","delta":"hi"}\n' })
      send?.({ type: 'stream-end', requestId: req.requestId })
    })

    // Build the request exactly as a machine-workspace agent turn does: the
    // interceptor appends the client's own `/api/workspaces/<id>/…` path to the
    // relay base and rewrites the workspace id to the machine's local one.
    const calls: string[] = []
    const http = {
      get: async (path: string) => {
        calls.push(path)
        return { data: {} }
      },
      post: async (path: string) => {
        calls.push(path)
        return { data: {} }
      },
      patch: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
      request: async () => ({ data: {} }),
    } as any
    const proxy = createRemoteAwareHttpClient(http, () => ({
      remoteProxyBaseUrl: 'https://studio.shogo.ai/api/machines/i-mac/w/lw-9',
      machineWorkspaceId: 'lw-9',
    }))
    await proxy.post(`/api/workspaces/${CLOUD_WORKSPACE}/agent-proxy/agent/chat`, { messages: [] })

    const sent = new URL(calls[0])
    expect(sent.pathname).toBe('/api/machines/i-mac/w/lw-9/api/workspaces/lw-9/agent-proxy/agent/chat')

    const res = await buildApp().request(`${sent.pathname}${sent.search}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ messages: [] }),
    })
    expect(res.status).toBe(200)
    // The streaming branch — classification runs on the joined path, so a wrong
    // join would show up here as a buffered (never-ending or empty) reply.
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toContain('hi')
    expect(frame.path).toBe('/api/workspaces/lw-9/agent-proxy/agent/chat')
    expect(String(frame.path).startsWith('/api/api')).toBe(false)
  })
})
