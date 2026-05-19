// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Federation fallback tests for `apps/api/src/routes/instances.ts`.
 *
 * Covers the SHOGO_LOCAL_MODE branches added so the local API can
 * transparently proxy instance traffic to the cloud upstream it's
 * already signed in to:
 *   - GET /instances                  merges local + cloud rows
 *   - GET /instances/:id              forwards on local-miss
 *   - POST /instances/:id/request-connect / /proxy / /proxy/stream / /p/*
 *                                     forwarded on local-miss
 *   - 401 from cloud flips the cloudKeyRejected flag observed by the
 *     existing /local/cloud-login/status banner
 *   - Federation gating: with SHOGO_LOCAL_MODE unset, behavior is
 *     identical to the original local-only handler (404)
 *
 *   bun test apps/api/src/__tests__/instances-federation.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// Enable local-mode + a stored cloud credential before instances.ts loads.
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.SHOGO_API_KEY = 'shogo_sk_test'
process.env.SHOGO_CLOUD_URL = 'https://cloud.test'

// ─── In-memory Prisma stub ──────────────────────────────────────────────────

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
  kind: string
}
const instancesById = new Map<string, Instance>()
const membersByUserWs = new Map<string, { id: string; userId: string; workspaceId: string }>()
const memberKey = (u: string, w: string) => `${u}::${w}`

const localConfigMap = new Map<string, string>()

const mockPrisma = {
  instance: {
    findUnique: async (args: any) => {
      const inst = instancesById.get(args.where.id)
      return inst ? { ...inst } : null
    },
    findMany: async (args: any) =>
      [...instancesById.values()].filter((i) => i.workspaceId === args.where.workspaceId),
    update: async (args: any) => {
      const inst = instancesById.get(args.where.id)
      if (!inst) throw new Error('not found')
      Object.assign(inst, args.data, { updatedAt: new Date() })
      return { ...inst }
    },
  },
  member: {
    findFirst: async (args: any) => membersByUserWs.get(memberKey(args.where.userId, args.where.workspaceId)) ?? null,
  },
  localConfig: {
    findUnique: async (args: any) => {
      const v = localConfigMap.get(args.where.key)
      return v != null ? { key: args.where.key, value: v } : null
    },
    deleteMany: async (args: any) => {
      const existed = localConfigMap.delete(args.where.key)
      return { count: existed ? 1 : 0 }
    },
  },
}

// Stub the instance-tunnel module that local-auth's signout imports
// lazily — the test only needs the call to succeed, not actually do
// anything.
mock.module('../lib/instance-tunnel', () => ({
  stopInstanceTunnel: () => {},
}))

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))

mock.module('../routes/api-keys', () => ({
  resolveApiKey: async () => null,
}))

mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => {},
}))

const { instanceRoutes, _testing } = await import('../routes/instances')
const { _resetInstanceCache, _resetUpstreamCredentialCache } = await import('../lib/federated-upstream')
// Importing local-auth at module load installs its onUpstreamRejection
// subscription. The cloudKeyRejected test below depends on this hook
// already being wired before the federated fetch fires its 401.
const { localAuthRoutes } = await import('../routes/local-auth')

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

function seedLocalInstance(overrides: Partial<Instance> = {}): Instance {
  const inst: Instance = {
    id: 'local-i-1',
    workspaceId: 'ws-1',
    hostname: 'mac',
    name: 'Local Mac',
    os: 'darwin',
    arch: 'arm64',
    lastSeenAt: new Date(),
    metadata: {},
    wsRequestedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    kind: 'desktop',
    ...overrides,
  }
  instancesById.set(inst.id, inst)
  return inst
}

// ─── Fetch stub ─────────────────────────────────────────────────────────────

type FetchCall = { url: string; init?: RequestInit }
const realFetch = globalThis.fetch
let fetchCalls: FetchCall[] = []

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as unknown as typeof fetch
}

function jsonResp(body: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeEach(() => {
  instancesById.clear()
  membersByUserWs.clear()
  _testing.tunnels.clear()
  _testing.activeViewers.clear()
  fetchCalls = []
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.SHOGO_API_KEY = 'shogo_sk_test'
  localConfigMap.clear()
  // Default: a cloud workspace is linked so the list-merge path runs.
  // Detail / proxy / p/* fallbacks don't read SHOGO_KEY_INFO — they only
  // need a credential — so this seed doesn't affect those tests.
  localConfigMap.set('SHOGO_KEY_INFO', JSON.stringify({ workspace: { id: 'cloud-ws-1' } }))
  _resetInstanceCache()
  _resetUpstreamCredentialCache()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// ─── GET /instances (merge) ────────────────────────────────────────────────

describe('GET /instances — federated merge', () => {
  test('returns local rows tagged origin=local plus cloud rows tagged with cloud host', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedLocalInstance({ id: 'local-i-1', name: 'Mine' })

    installFetch((url) => {
      // Local workspaceId 'ws-1' is translated to the cloud workspaceId
      // from SHOGO_KEY_INFO ('cloud-ws-1') before forwarding — staging
      // would 403 a foreign local id.
      expect(url).toBe('https://cloud.test/api/instances?workspaceId=cloud-ws-1')
      return jsonResp({ instances: [
        { id: 'cloud-1', workspaceId: 'cloud-ws-1', name: 'VPS', status: 'online', kind: 'cli-worker' },
      ] })
    })

    const res = await buildApp().fetch(new Request('http://x/api/instances?workspaceId=ws-1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { instances: any[] }

    expect(body.instances).toHaveLength(2)
    const local = body.instances.find((i) => i.id === 'local-i-1')
    const remote = body.instances.find((i) => i.id === 'cloud-1')
    expect(local.origin).toBe('local')
    expect(remote.origin).toBe('cloud.test')
    expect(remote.name).toBe('VPS')
  })

  test('local row wins on id collision (cloud duplicate is dropped)', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedLocalInstance({ id: 'shared-id', name: 'Local Copy' })

    installFetch(() => jsonResp({ instances: [
      { id: 'shared-id', workspaceId: 'ws-1', name: 'Cloud Copy' },
    ] }))

    const res = await buildApp().fetch(new Request('http://x/api/instances?workspaceId=ws-1'))
    const body = (await res.json()) as { instances: any[] }
    expect(body.instances).toHaveLength(1)
    expect(body.instances[0].name).toBe('Local Copy')
    expect(body.instances[0].origin).toBe('local')
  })

  test('returns only local rows when SHOGO_LOCAL_MODE is unset', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedLocalInstance()
    installFetch(() => { throw new Error('upstream must not be hit when federation is off') })

    const res = await buildApp().fetch(new Request('http://x/api/instances?workspaceId=ws-1'))
    const body = (await res.json()) as { instances: any[] }
    expect(body.instances).toHaveLength(1)
    expect(fetchCalls).toHaveLength(0)
  })

  test('cloud error degrades gracefully (local rows still returned)', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedLocalInstance()
    installFetch(() => new Response('', { status: 500 }))

    const res = await buildApp().fetch(new Request('http://x/api/instances?workspaceId=ws-1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { instances: any[] }
    expect(body.instances).toHaveLength(1)
    expect(body.instances[0].origin).toBe('local')
  })
})

// ─── GET /instances/:id ────────────────────────────────────────────────────

describe('GET /instances/:id — federated detail fallback', () => {
  test('local hit returns local row with origin=local', async () => {
    membersByUserWs.set(memberKey('u-1', 'ws-1'), { id: 'm-1', userId: 'u-1', workspaceId: 'ws-1' })
    seedLocalInstance()
    installFetch(() => { throw new Error('upstream must not be hit when local has the row') })

    const res = await buildApp().fetch(new Request('http://x/api/instances/local-i-1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.id).toBe('local-i-1')
    expect(body.origin).toBe('local')
  })

  test('local miss + federation on forwards to cloud and returns its response', async () => {
    installFetch((url) => {
      expect(url).toBe('https://cloud.test/api/instances/remote-only')
      return jsonResp({ id: 'remote-only', workspaceId: 'ws-1', name: 'VPS', status: 'online' })
    })

    const res = await buildApp().fetch(new Request('http://x/api/instances/remote-only'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.id).toBe('remote-only')
    expect(body.name).toBe('VPS')
  })

  test('local miss + cloud 404 returns 404', async () => {
    installFetch(() => jsonResp({ error: { code: 'not_found' } }, 404))
    const res = await buildApp().fetch(new Request('http://x/api/instances/nope'))
    expect(res.status).toBe(404)
  })

  test('local miss with SHOGO_LOCAL_MODE unset returns 404 (no fetch)', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    installFetch(() => { throw new Error('upstream must not be hit') })
    const res = await buildApp().fetch(new Request('http://x/api/instances/never-existed'))
    expect(res.status).toBe(404)
    expect(fetchCalls).toHaveLength(0)
  })
})

// ─── POST /instances/:id/request-connect ───────────────────────────────────

describe('POST /instances/:id/request-connect — federated fallback', () => {
  test('local miss forwards to cloud verbatim', async () => {
    installFetch((url, init) => {
      expect(url).toBe('https://cloud.test/api/instances/remote-only/request-connect')
      expect(init?.method).toBe('POST')
      const auth = new Headers(init?.headers as any).get('authorization')
      expect(auth).toBe('Bearer shogo_sk_test')
      return jsonResp({ ok: true, status: 'requested' })
    })

    const res = await buildApp().fetch(new Request('http://x/api/instances/remote-only/request-connect', {
      method: 'POST',
    }))
    expect(res.status).toBe(200)
    expect((await res.json() as any).status).toBe('requested')
  })

  test('local miss + federation off returns 404', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    installFetch(() => { throw new Error('no fetch when off') })
    const res = await buildApp().fetch(new Request('http://x/api/instances/remote-only/request-connect', {
      method: 'POST',
    }))
    expect(res.status).toBe(404)
  })
})

// ─── POST /instances/:id/proxy ─────────────────────────────────────────────

describe('POST /instances/:id/proxy — federated fallback', () => {
  test('local miss forwards the body to cloud and pipes the response back', async () => {
    installFetch((url, init) => {
      expect(url).toBe('https://cloud.test/api/instances/remote-only/proxy')
      expect(init?.method).toBe('POST')
      return jsonResp({ status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } })
    })

    const res = await buildApp().fetch(new Request('http://x/api/instances/remote-only/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'GET', path: '/health' }),
    }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.body).toBe('{"ok":true}')
  })
})

// ─── POST /instances/:id/proxy/stream ──────────────────────────────────────

describe('POST /instances/:id/proxy/stream — federated streaming pipe', () => {
  test('local miss pipes SSE chunks back without buffering', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: hello\n\n'))
        controller.enqueue(new TextEncoder().encode('data: world\n\n'))
        controller.close()
      },
    })
    installFetch(() => new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    }))

    const res = await buildApp().fetch(new Request('http://x/api/instances/remote-only/proxy/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'POST', path: '/agent/chat' }),
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const text = await res.text()
    expect(text).toBe('data: hello\n\ndata: world\n\n')
  })
})

// ─── /instances/:id/p/* transparent proxy ──────────────────────────────────

describe('ALL /instances/:id/p/* — federated transparent proxy', () => {
  test('local miss forwards entire path + querystring + body to cloud', async () => {
    installFetch((url, init) => {
      expect(url).toBe('https://cloud.test/api/instances/remote-only/p/api/projects?cursor=x')
      expect(init?.method).toBe('POST')
      return jsonResp({ ok: true })
    })

    const res = await buildApp().fetch(new Request(
      'http://x/api/instances/remote-only/p/api/projects?cursor=x',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      },
    ))
    expect(res.status).toBe(200)
    expect((await res.json() as any).ok).toBe(true)
  })

  test('local miss + federation off returns 404', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    const res = await buildApp().fetch(new Request(
      'http://x/api/instances/remote-only/p/api/projects',
      { method: 'GET' },
    ))
    expect(res.status).toBe(404)
  })
})

// ─── 401 → cloudKeyRejected wiring ─────────────────────────────────────────

describe('401 from cloud flips cloudKeyRejected', () => {
  test('a forwarded 401 surfaces through /api/local/cloud-login/status', async () => {
    // Trigger a 401 via the federated detail handler.
    installFetch(() => jsonResp({ error: 'unauthorized' }, 401))
    const res = await buildApp().fetch(new Request('http://x/api/instances/remote-only'))
    // The forwarded 401 is propagated to the client as-is.
    expect(res.status).toBe(401)

    // The local-auth status route should now report cloudKeyRejected:true
    // because the federated module emitted an onUpstreamRejection event
    // which local-auth subscribes to at module load (installed above).
    localConfigMap.set('SHOGO_API_KEY', 'shogo_sk_test')
    const authApp = new Hono()
    authApp.route('/api', localAuthRoutes())
    const statusRes = await authApp.fetch(new Request('http://x/api/local/cloud-login/status'))
    expect(statusRes.status).toBe(200)
    const body = (await statusRes.json()) as any
    expect(body.cloudKeyRejected).toBe(true)

    // Reset the flag by calling signout so subsequent tests don't see it.
    await authApp.fetch(new Request('http://x/api/local/cloud-login/signout', { method: 'POST' }))
  })
})
