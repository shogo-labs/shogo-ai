// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The desktop relay for cloud workspaces, against a stub cloud: per-workspace
 * keys, prefix stripping, cookie dropping, SSE pass-through, the team chat
 * WebSocket (typing/presence), key re-sync on 403, the merged workspace list
 * (local and cloud workspaces side by side), and signed-out behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const configRows = new Map<string, string>()
const prisma = {
  localConfig: {
    findUnique: async ({ where }: any) => (configRows.has(where.key) ? { key: where.key, value: configRows.get(where.key) } : null),
    upsert: async ({ where, create, update }: any) => {
      configRows.set(where.key, configRows.has(where.key) ? update.value : create.value)
      return { key: where.key }
    },
    deleteMany: async ({ where }: any) => {
      configRows.delete(where.key)
      return { count: 1 }
    },
  },
}
mock.module('../lib/prisma', () => ({ prisma }))

const cloudWorkspaces = await import('../services/cloud-workspaces')
const { cloudSocketRelayHandlers, cloudWorkspaceListMiddleware, isCloudSocketRelayData, localCloudWorkspaceRoutes } = await import(
  '../routes/local-cloud-proxy'
)

interface Seen {
  path: string
  auth: string | null
  cookie: string | null
  method: string
  body: string
}
const seen: Seen[] = []
let syncCalls = 0
let syncResponse: any = { ok: true, workspaces: [], removed: [] }
let forbidNext = false

const upstream = new Hono()
upstream.post('/api/cli/device-keys/sync', async (c) => {
  syncCalls++
  return c.json(syncResponse)
})
upstream.all('/api/*', async (c) => {
  seen.push({
    path: new URL(c.req.url).pathname + new URL(c.req.url).search,
    auth: c.req.header('authorization') ?? null,
    cookie: c.req.header('cookie') ?? null,
    method: c.req.method,
    body: c.req.method === 'GET' ? '' : await c.req.text(),
  })
  if (forbidNext) {
    forbidNext = false
    return c.json({ error: { code: 'forbidden' } }, 403)
  }
  if (c.req.path.endsWith('/events')) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"ready"}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: {"type":"message.created"}\n\n'))
        // Split mid-line to check events are reassembled before swapping ids.
        controller.enqueue(new TextEncoder().encode('data: {"type":"reaction","userId":"clo'))
        controller.enqueue(new TextEncoder().encode('ud-user"}\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'cloud=1' } })
  }
  if (c.req.path === '/api/messages/m1') {
    return c.json({
      createdBy: 'cloud-user',
      authorEmail: 'russ@example.com',
      reactions: { 'cloud-user': ['+1'], teammate: ['+1'] },
      mentions: ['cloud-user', 'teammate'],
    })
  }
  return c.json({ ok: true, path: c.req.path })
})

const socketAuth: string[] = []
const cloudFrames: any[] = []

let server: ReturnType<typeof Bun.serve>
let desktop: ReturnType<typeof Bun.serve>
let app: Hono
let signedInUser: string | null = 'local-user'

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname.endsWith('/rt')) {
        socketAuth.push(req.headers.get('authorization') ?? '')
        if (srv.upgrade(req, { data: { path: new URL(req.url).pathname } })) return undefined as any
      }
      return upstream.fetch(req)
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: 'ready' }))
      },
      message(ws, message) {
        const frame = JSON.parse(String(message))
        // Echo typing back as another user would see it, so the test can watch it round-trip.
        if (frame.type === 'typing') ws.send(JSON.stringify({ type: 'typing', conversationId: frame.conversationId, userId: 'teammate' }))
        if (frame.type === 'presence') ws.send(JSON.stringify({ type: 'presence', status: frame.status, path: (ws.data as any).path }))
        if (frame.type === 'echo') {
          cloudFrames.push(frame)
          ws.send(JSON.stringify({ type: 'echo', userId: 'cloud-user' }))
        }
      },
    },
  })
  process.env.SHOGO_CLOUD_URL = `http://localhost:${server.port}`
  app = new Hono()
  app.use('/api/workspaces', cloudWorkspaceListMiddleware)
  app.route(
    '/api',
    localCloudWorkspaceRoutes({ resolveUserId: async () => signedInUser, resolveUserEmail: async () => 'Local@Desktop.dev' }),
  )
  app.get('/api/workspaces', (c) =>
    c.json({
      ok: true,
      items: [
        { id: 'local-personal', name: 'Personal', kind: 'personal' },
        { id: 'local-ws', name: 'My Workspace', kind: 'team' },
      ],
      total: 2,
    }),
  )
  app.get('/api/workspaces/:id', (c) => c.json({ ok: true, data: { id: c.req.param('id'), source: 'local' } }))
  desktop = Bun.serve({
    port: 0,
    fetch: (req, srv) => app.fetch(req, srv),
    websocket: {
      open: (ws) => isCloudSocketRelayData(ws.data) && cloudSocketRelayHandlers.open(ws),
      message: (ws, m) => isCloudSocketRelayData(ws.data) && cloudSocketRelayHandlers.message(ws, m as any),
      close: (ws) => isCloudSocketRelayData(ws.data) && cloudSocketRelayHandlers.close(ws),
    },
  })
})

afterAll(() => {
  desktop.stop(true)
  server.stop(true)
  delete process.env.SHOGO_CLOUD_URL
  delete process.env.SHOGO_API_KEY
})

beforeEach(async () => {
  seen.length = 0
  socketAuth.length = 0
  syncCalls = 0
  forbidNext = false
  signedInUser = 'local-user'
  syncResponse = { ok: true, workspaces: [], removed: [] }
  configRows.clear()
  cloudWorkspaces._resetCloudWorkspacesForTests()
  process.env.SHOGO_API_KEY = 'shogo_sk_primary'
  await cloudWorkspaces.setCloudWorkspaces({
    user: { id: 'cloud-user', name: 'Russ', email: 'russ@example.com' },
    workspaces: [
      { workspace: { id: 'ws-acme', name: 'Acme', slug: 'acme' }, key: 'shogo_sk_acme' },
      { workspace: { id: 'ws-beta', name: 'Beta', slug: 'beta' }, key: 'shogo_sk_beta' },
    ],
  })
})

describe('cloud workspace relay', () => {
  test('uses the key for the workspace in the URL and strips the prefix', async () => {
    const a = await app.request('/api/cloud/ws-acme/conversations?workspaceId=ws-acme', {
      headers: { cookie: 'better-auth.session_token=local' },
    })
    expect(a.status).toBe(200)
    expect(await a.json()).toEqual({ ok: true, path: '/api/conversations' })
    await app.request('/api/cloud/ws-beta/projects')

    expect(seen.map((s) => [s.path, s.auth])).toEqual([
      ['/api/conversations?workspaceId=ws-acme', 'Bearer shogo_sk_acme'],
      ['/api/projects', 'Bearer shogo_sk_beta'],
    ])
    expect(seen[0]!.cookie).toBeNull()
  })

  test('forwards request bodies', async () => {
    const res = await app.request('/api/cloud/ws-acme/conversations/c1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello from the desktop' }),
    })
    expect(res.status).toBe(200)
    expect(seen[0]).toMatchObject({ method: 'POST', body: '{"text":"hello from the desktop"}' })
  })

  test('swaps the local account for the cloud one in paths, queries and JSON bodies', async () => {
    await app.request('/api/cloud/ws-acme/invitations?email=Local%40Desktop.dev')
    await app.request('/api/cloud/ws-acme/starred-projects?userId=local-user&projectId=local-user-ish')
    await app.request('/api/cloud/ws-acme/users/local-user/profile')
    await app.request('/api/cloud/ws-acme/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'local-user', createdBy: 'local-user', members: [{ userId: 'local-user' }] }),
    })

    expect(seen.map((s) => s.path)).toEqual([
      '/api/invitations?email=russ%40example.com',
      '/api/starred-projects?userId=cloud-user&projectId=local-user-ish',
      '/api/users/cloud-user/profile',
      '/api/projects',
    ])
    expect(JSON.parse(seen[3]!.body)).toEqual({ name: 'cloud-user', createdBy: 'cloud-user', members: [{ userId: 'cloud-user' }] })
  })

  test('streams server-sent events through and drops upstream cookies', async () => {
    const res = await app.request('/api/cloud/ws-acme/workspaces/ws-acme/conversations/events')
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('set-cookie')).toBeNull()
    const text = await res.text()
    expect(text).toContain('"ready"')
    expect(text).toContain('"message.created"')
    expect(text).toContain('data: {"type":"reaction","userId":"local-user"}\n\n')
    expect(text).not.toContain('cloud-user')
  })

  test('replies show the cloud account as the local one, but keep its email', async () => {
    const res = await app.request('/api/cloud/ws-acme/messages/m1')
    expect(await res.json()).toEqual({
      createdBy: 'local-user',
      authorEmail: 'russ@example.com',
      reactions: { 'local-user': ['+1'], teammate: ['+1'] },
      mentions: ['local-user', 'teammate'],
    })
  })

  test('a 403 from cloud re-syncs keys', async () => {
    forbidNext = true
    const res = await app.request('/api/cloud/ws-acme/projects')
    expect(res.status).toBe(403)
    await Bun.sleep(20)
    expect(syncCalls).toBe(1)
  })

  test('unknown workspace is 404, signed out is 401, no local session is 401', async () => {
    expect((await app.request('/api/cloud/ws-nope/projects')).status).toBe(404)

    delete process.env.SHOGO_API_KEY
    await cloudWorkspaces.clearCloudWorkspaces()
    const out = await app.request('/api/cloud/ws-acme/projects')
    expect(out.status).toBe(401)
    expect((await out.json()).error.code).toBe('cloud_signed_out')

    process.env.SHOGO_API_KEY = 'shogo_sk_primary'
    signedInUser = null
    expect((await app.request('/api/cloud/ws-acme/projects')).status).toBe(401)
    expect(seen).toHaveLength(0)
  })

  test('cloud outage is 502 and marks cloud unreachable', async () => {
    const saved = process.env.SHOGO_CLOUD_URL
    process.env.SHOGO_CLOUD_URL = 'http://127.0.0.1:1'
    try {
      const res = await app.request('/api/cloud/ws-acme/projects')
      expect(res.status).toBe(502)
      expect((await res.json()).error.code).toBe('cloud_unreachable')
      const status = await (await app.request('/api/local/cloud-workspaces')).json()
      expect(status.reachable).toBe(false)
    } finally {
      process.env.SHOGO_CLOUD_URL = saved
    }
    await app.request('/api/cloud/ws-acme/projects')
    expect((await (await app.request('/api/local/cloud-workspaces')).json()).reachable).toBe(true)
  })
})

describe('workspace list and status', () => {
  test('cloud workspaces are appended to the local list', async () => {
    const body = await (await app.request('/api/workspaces')).json()
    expect(body.items.map((w: any) => [w.id, w.source ?? 'local'])).toEqual([
      ['local-personal', 'local'],
      ['local-ws', 'local'],
      ['ws-acme', 'cloud'],
      ['ws-beta', 'cloud'],
    ])
    expect(body.total).toBe(4)
  })

  test('a cloud Personal workspace is listed alongside the local one', async () => {
    await cloudWorkspaces.setCloudWorkspaces({
      user: { id: 'cloud-user', name: 'Russ', email: null },
      workspaces: [
        { workspace: { id: 'ws-acme', name: 'Acme', slug: 'acme', kind: 'team' }, key: 'shogo_sk_acme' },
        { workspace: { id: 'cloud-personal', name: 'Russ Personal', slug: 'p', kind: 'personal' }, key: 'shogo_sk_primary' },
      ],
    })
    const body = await (await app.request('/api/workspaces')).json()
    expect(body.items.map((w: any) => [w.id, w.kind, w.source ?? 'local'])).toEqual([
      ['local-personal', 'personal', 'local'],
      ['local-ws', 'team', 'local'],
      ['cloud-personal', 'personal', 'cloud'],
      ['ws-acme', 'team', 'cloud'],
    ])
    expect(body.total).toBe(4)
    const status = await (await app.request('/api/local/cloud-workspaces')).json()
    expect(status.workspaces.map((w: any) => w.kind)).toEqual(['team', 'personal'])
  })

  test('reading one cloud workspace goes to cloud, local ones stay local', async () => {
    await app.request('/api/workspaces/ws-acme')
    expect(seen[0]).toMatchObject({ path: '/api/workspaces/ws-acme', auth: 'Bearer shogo_sk_acme' })
    const local = await (await app.request('/api/workspaces/local-ws')).json()
    expect(local.data.source).toBe('local')
  })

  test('status lists workspaces and the cloud identity without keys', async () => {
    const body = await (await app.request('/api/local/cloud-workspaces')).json()
    expect(body.signedIn).toBe(true)
    expect(body.user).toEqual({ id: 'cloud-user', name: 'Russ', email: 'russ@example.com' })
    expect(body.workspaces).toEqual([
      { id: 'ws-acme', name: 'Acme', slug: 'acme', kind: 'team' },
      { id: 'ws-beta', name: 'Beta', slug: 'beta', kind: 'team' },
    ])
    expect(JSON.stringify(body)).not.toContain('shogo_sk_')
  })

  test('sync adds newly joined workspaces and drops ones the user left', async () => {
    syncResponse = {
      ok: true,
      workspaces: [
        { workspace: { id: 'ws-acme', name: 'Acme Inc', slug: 'acme' } },
        { workspace: { id: 'ws-new', name: 'New Team', slug: 'new' }, key: 'shogo_sk_new' },
      ],
      removed: ['ws-beta'],
    }
    const res = await app.request('/api/local/cloud-workspaces/sync', { method: 'POST' })
    expect((await res.json()).workspaces.map((w: any) => w.id)).toEqual(['ws-acme', 'ws-new'])
    expect(await cloudWorkspaces.cloudWorkspaceKey('ws-acme')).toBe('shogo_sk_acme')
    expect(await cloudWorkspaces.cloudWorkspaceKey('ws-new')).toBe('shogo_sk_new')
    expect(await cloudWorkspaces.cloudWorkspaceKey('ws-beta')).toBeNull()
  })

  test('a sign-in from before per-workspace keys backfills its list on sync', async () => {
    configRows.clear()
    cloudWorkspaces._resetCloudWorkspacesForTests()
    configRows.set(
      'SHOGO_KEY_INFO',
      JSON.stringify({ workspace: { id: 'ws-acme' }, user: { id: 'cloud-user', name: 'Russ', email: 'russ@example.com' } }),
    )
    syncResponse = {
      ok: true,
      workspaces: [
        { workspace: { id: 'ws-acme', name: 'Acme', slug: 'acme', kind: 'team' }, key: 'shogo_sk_primary' },
        { workspace: { id: 'cloud-personal', name: 'Russ Personal', slug: 'p', kind: 'personal' }, key: 'shogo_sk_personal' },
      ],
      removed: [],
    }
    await app.request('/api/local/cloud-workspaces/sync', { method: 'POST' })
    const status = await (await app.request('/api/local/cloud-workspaces')).json()
    expect(status.user).toEqual({ id: 'cloud-user', name: 'Russ', email: 'russ@example.com' })
    expect(status.workspaces.map((w: any) => w.id)).toEqual(['ws-acme', 'cloud-personal'])
    expect(await cloudWorkspaces.cloudWorkspaceKey('cloud-personal')).toBe('shogo_sk_personal')
  })

  test('signing out clears them from the list', async () => {
    await cloudWorkspaces.clearCloudWorkspaces()
    const body = await (await app.request('/api/workspaces')).json()
    expect(body.items.map((w: any) => w.id)).toEqual(['local-personal', 'local-ws'])
  })
})

describe('team chat socket relay', () => {
  function open(path: string): Promise<{ ws: WebSocket; frames: any[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${desktop.port}${path}`)
      const frames: any[] = []
      ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)))
      ws.onopen = () => resolve({ ws, frames })
      ws.onerror = () => reject(new Error('socket failed'))
    })
  }
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await Bun.sleep(10)
    expect(fn()).toBe(true)
  }

  test('pipes typing and presence both ways with the workspace key', async () => {
    const { ws, frames } = await open('/api/cloud/ws-acme/workspaces/ws-acme/rt')
    // Sent before cloud answered: queued, then delivered.
    ws.send(JSON.stringify({ type: 'typing', conversationId: 'c1' }))
    ws.send(JSON.stringify({ type: 'presence', status: 'away' }))
    await until(() => frames.length >= 3)
    expect(frames).toEqual([
      { type: 'ready' },
      { type: 'typing', conversationId: 'c1', userId: 'teammate' },
      { type: 'presence', status: 'away', path: '/api/workspaces/ws-acme/rt' },
    ])
    expect(socketAuth).toEqual(['Bearer shogo_sk_acme'])
    ws.close()
    await until(() => server.pendingWebSockets === 0)
  })

  test('swaps the account in socket frames both ways', async () => {
    const { ws, frames } = await open('/api/cloud/ws-acme/workspaces/ws-acme/rt')
    ws.send(JSON.stringify({ type: 'echo', userId: 'local-user' }))
    await until(() => frames.length >= 2)
    expect(cloudFrames).toEqual([{ type: 'echo', userId: 'cloud-user' }])
    expect(frames[1]).toEqual({ type: 'echo', userId: 'local-user' })
    ws.close()
    await until(() => server.pendingWebSockets === 0)
  })

  test('closing the client closes the cloud socket, and cloud closing closes the client', async () => {
    const first = await open('/api/cloud/ws-acme/workspaces/ws-acme/rt')
    await until(() => server.pendingWebSockets === 1)
    first.ws.close()
    await until(() => server.pendingWebSockets === 0)

    const { ws } = await open('/api/cloud/ws-beta/workspaces/ws-beta/rt')
    const closed = new Promise<number>((r) => (ws.onclose = (ev) => r(ev.code)))
    await until(() => server.pendingWebSockets === 1)
    server.stop(true)
    expect(await closed).toBe(1011)
    server = Bun.serve({ port: server.port, fetch: upstream.fetch })
  })

  test('refuses unknown workspaces and mismatched paths', async () => {
    const res = await fetch(`http://localhost:${desktop.port}/api/cloud/ws-nope/workspaces/ws-nope/rt`, {
      headers: { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
    })
    expect(res.status).toBe(404)
    const mismatch = await fetch(`http://localhost:${desktop.port}/api/cloud/ws-acme/workspaces/ws-beta/rt`, {
      headers: { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
    })
    expect(mismatch.status).toBe(400)
  })
})
