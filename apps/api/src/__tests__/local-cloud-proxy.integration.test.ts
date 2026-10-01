// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The desktop relay for cloud team workspaces, against a stub cloud:
 * per-workspace keys, prefix stripping, cookie dropping, SSE pass-through,
 * key re-sync on 403, the merged workspace list, and signed-out behavior.
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
const { cloudWorkspaceListMiddleware, localCloudWorkspaceRoutes } = await import('../routes/local-cloud-proxy')

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
        controller.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'cloud=1' } })
  }
  return c.json({ ok: true, path: c.req.path })
})

let server: ReturnType<typeof Bun.serve>
let app: Hono
let signedInUser: string | null = 'local-user'

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: upstream.fetch })
  process.env.SHOGO_CLOUD_URL = `http://localhost:${server.port}`
  app = new Hono()
  app.use('/api/workspaces', cloudWorkspaceListMiddleware)
  app.route('/api', localCloudWorkspaceRoutes({ resolveUserId: async () => signedInUser }))
  app.get('/api/workspaces', (c) => c.json({ ok: true, items: [{ id: 'local-ws', name: 'My Workspace' }], total: 1 }))
  app.get('/api/workspaces/:id', (c) => c.json({ ok: true, data: { id: c.req.param('id'), source: 'local' } }))
})

afterAll(() => {
  server.stop(true)
  delete process.env.SHOGO_CLOUD_URL
  delete process.env.SHOGO_API_KEY
})

beforeEach(async () => {
  seen.length = 0
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

  test('streams server-sent events through and drops upstream cookies', async () => {
    const res = await app.request('/api/cloud/ws-acme/workspaces/ws-acme/conversations/events')
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('set-cookie')).toBeNull()
    const text = await res.text()
    expect(text).toContain('"ready"')
    expect(text).toContain('"message.created"')
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
      ['local-ws', 'local'],
      ['ws-acme', 'cloud'],
      ['ws-beta', 'cloud'],
    ])
    expect(body.total).toBe(3)
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
      { id: 'ws-acme', name: 'Acme', slug: 'acme' },
      { id: 'ws-beta', name: 'Beta', slug: 'beta' },
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

  test('signing out clears them from the list', async () => {
    await cloudWorkspaces.clearCloudWorkspaces()
    const body = await (await app.request('/api/workspaces')).json()
    expect(body.items.map((w: any) => w.id)).toEqual(['local-ws'])
  })
})
