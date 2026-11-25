// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Body-only creates through the home-region write router (SHO-585 §A).
 *
 * A create has no `:id` in its path to resolve by, so the router's resolver
 * reads the JSON body — which means the router must forward exactly those bytes
 * (a consumed stream cannot be replayed) and the local handler must still be
 * able to read the same body when this region owns the write.
 *
 * Real middleware + real resolver; only the peer hop and the DB are fakes.
 *
 *   bun test apps/api/src/middleware/__tests__/home-region-router.body-create.test.ts
 */

import { beforeEach, describe, expect, test, mock } from 'bun:test'
import { Hono } from 'hono'

// --- fakes -----------------------------------------------------------------
const workspaces: Record<string, { homeRegion: string | null } | null> = {
  ws_eu: { homeRegion: 'eu-frankfurt-1' },
  ws_us: { homeRegion: 'us-ashburn-1' },
  ws_stranded: { homeRegion: 'unknown-region-9' },
}
const chatSessions: Record<string, { workspaceId: string | null; contextType: string; contextId: string | null }> = {
  sess_eu: { workspaceId: 'ws_eu', contextType: 'workspace', contextId: null },
  sess_us: { workspaceId: 'ws_us', contextType: 'workspace', contextId: null },
  sess_stranded: { workspaceId: 'ws_stranded', contextType: 'workspace', contextId: null },
}
const projects: Record<string, { workspaceId: string }> = {
  proj_eu: { workspaceId: 'ws_eu' },
}
/** The identity owner: homed in *this* region — the trap the fail-closed rule exists for. */
const USERS: Record<string, { homeRegion: string } | null> = {
  usr_us: { homeRegion: 'us-ashburn-1' },
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => workspaces[id] ?? null,
    },
    chatSession: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => chatSessions[id] ?? null,
    },
    project: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => projects[id] ?? null,
    },
    user: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => USERS[id] ?? null,
    },
  },
}))

const PEERS: Record<string, { id: string; label: string; url: string }> = {
  'eu-frankfurt-1': { id: 'eu-frankfurt-1', label: 'EU', url: 'https://eu.studio.shogo.ai' },
}

mock.module('../../lib/region', () => ({
  RAW_REGION_ID: 'us-ashburn-1',
  PRIMARY_REGION: 'us-ashburn-1',
  REGION_PEERS: Object.values(PEERS),
  getPeer: (id: string) => PEERS[id],
}))

mock.module('../../lib/resolve-user-id', () => ({
  resolveUserHomeRegionUserId: async () => 'usr_us',
}))

interface ProxyCall {
  region: string
  path: string
  body: unknown
}
const proxyCalls: ProxyCall[] = []
const PROXY_RESPONSE = new Response('proxied', { status: 299 })

mock.module('../../lib/region-peer-proxy', () => ({
  proxyToPeer: async (c: any, region: string, opts: { body?: unknown } = {}) => {
    proxyCalls.push({ region, path: new URL(c.req.url).pathname, body: opts.body })
    return PROXY_RESPONSE
  },
  isProxiedRequest: (c: any) => c.req.header('x-shogo-home-region-proxy') === '1',
}))

const { homeRegionWriteProxy } = await import('../home-region-router')
const { BODY_CREATE_SEGMENTS } = await import('../../lib/resolve-workspace-id')

const SAVED_MODE = process.env.HOME_REGION_ROUTING

beforeEach(() => {
  proxyCalls.length = 0
  process.env.HOME_REGION_ROUTING = 'enforce'
})

// --- harness ---------------------------------------------------------------
/** An app whose one route records that it ran here and echoes what it read. */
function makeApp() {
  const handled: unknown[] = []
  const app = new Hono()
  app.use('*', homeRegionWriteProxy)
  app.post('*', async (c) => {
    // Reading the body here is the regression this guards: the resolver may
    // already have parsed it.
    const body = await c.req.json().catch(() => null)
    handled.push(body)
    return c.json({ local: true, body })
  })
  return { app, handled }
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(
    new Request(`https://us.studio.shogo.ai${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

/**
 * Every collection whose create names its workspace in the body. A row written
 * here is drained / deleted / replied to by the home region, so a local write
 * strands it (SHO-585).
 */
const BODY_CREATE_CASES: Array<{ collection: string; body: Record<string, unknown> }> = [
  { collection: 'chat-queued-messages', body: { sessionId: 'sess_eu', content: 'hi', body: 'hi' } },
  { collection: 'chat-messages', body: { sessionId: 'sess_eu', role: 'user', content: 'hi' } },
  { collection: 'tool-call-logs', body: { chatSessionId: 'sess_eu', toolName: 'read_file' } },
  { collection: 'chat-session-projects', body: { sessionId: 'sess_eu' } },
  { collection: 'project-folders', body: { projectId: 'proj_eu', name: 'Folder' } },
  { collection: 'starred-projects', body: { workspaceId: 'ws_eu', projectId: 'proj_eu' } },
  { collection: 'folders', body: { workspaceId: 'ws_eu', name: 'Folder' } },
]

describe('body-only creates are forwarded to the home region', () => {
  test('the table above covers every collection the resolver reads a body for', () => {
    expect(BODY_CREATE_CASES.map((c) => c.collection).sort()).toEqual([...BODY_CREATE_SEGMENTS].sort())
  })

  for (const { collection, body } of BODY_CREATE_CASES) {
    test(`POST /api/${collection} → proxied to the EU home with the full body`, async () => {
      const { app, handled } = makeApp()
      const res = await post(app, `/api/${collection}`, body)

      expect((res as any).status).toBe(299)
      expect(handled).toHaveLength(0)
      expect(proxyCalls).toHaveLength(1)
      expect(proxyCalls[0].region).toBe('eu-frankfurt-1')
      // Byte-for-byte: the peer must receive what the client sent, not `{}`.
      expect(proxyCalls[0].body).toBe(JSON.stringify(body))
    })
  }

  test('the acceptance case: a queued message for an EU session served by US', async () => {
    const { app, handled } = makeApp()
    const body = { sessionId: 'sess_eu', content: 'are you there?', body: 'are you there?' }
    await post(app, '/api/chat-queued-messages', body)
    expect(handled).toHaveLength(0)
    expect(JSON.parse(String(proxyCalls[0].body))).toEqual(body)
  })

  test('fails closed (503, no local row) when the home region is unreachable', async () => {
    const { app, handled } = makeApp()
    const res = await post(app, '/api/chat-queued-messages', { sessionId: 'sess_stranded', content: 'x', body: 'x' })
    expect((res as any).status).toBe(503)
    expect(handled).toHaveLength(0)
    expect(proxyCalls).toHaveLength(0)
  })
})

describe('the same request stays local', () => {
  test('when the workspace is homed here — and the handler can still read the body', async () => {
    const { app, handled } = makeApp()
    const body = { sessionId: 'sess_us', content: 'hi', body: 'hi' }
    const res = await post(app, '/api/chat-queued-messages', body)

    expect(proxyCalls).toHaveLength(0)
    expect((res as any).status).toBe(200)
    expect(handled).toEqual([body])
  })

  test('when the router is off (single-region / desktop)', async () => {
    process.env.HOME_REGION_ROUTING = 'off'
    const { app, handled } = makeApp()
    const body = { sessionId: 'sess_eu', content: 'hi', body: 'hi' }
    const res = await post(app, '/api/chat-queued-messages', body)

    expect(proxyCalls).toHaveLength(0)
    expect((res as any).status).toBe(200)
    expect(handled).toEqual([body])
  })

  test('when a non-fail-closed collection names no workspace it can resolve', async () => {
    // Everything outside FAIL_CLOSED_COLLECTIONS still falls open to local: a
    // missed proxy hop there costs a replicated row, not a stranded one.
    const { app, handled } = makeApp()
    const res = await post(app, '/api/chat-messages', { sessionId: 'sess_missing', role: 'user', content: 'x' })

    expect(proxyCalls).toHaveLength(0)
    expect((res as any).status).toBe(200)
    expect(handled).toHaveLength(1)
  })

  test('when the body is not JSON (no body read, no body lost)', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    const app = new Hono()
    let seen: string | null = null
    app.use('*', homeRegionWriteProxy)
    app.post('*', async (c) => {
      seen = await c.req.text()
      return c.json({ ok: true })
    })
    const res = await app.request(
      new Request('https://us.studio.shogo.ai/api/project-folders', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'not json',
      }),
    )
    expect((res as any).status).toBe(200)
    expect(seen).toBe('not json')
    expect(proxyCalls).toHaveLength(0)
  })
})

describe('a fail-closed create is refused rather than stranded', () => {
  /**
   * The queued message is drained and deleted by the region that owns its
   * *session*. With no workspace in the body there is no such region, so every
   * alternative is a lost message: a local row here, or — worse, because it
   * looks successful — a row forwarded to the identity owner's region (this one).
   */
  test('an unplaceable body is a retryable 503, not a local write', async () => {
    const { app, handled } = makeApp()
    const res = await post(app, '/api/chat-queued-messages', { sessionId: 'sess_missing', content: 'x', body: 'x' })

    expect((res as any).status).toBe(503)
    expect(handled).toHaveLength(0)
    expect(proxyCalls).toHaveLength(0)
  })

  test('the identity rule may not claim it, even when the user is homed here', async () => {
    // `usr_us` is homed in this very region, so without the guard the row would
    // be written locally and never drained — the production bug verbatim.
    const { app, handled } = makeApp()
    const res = await post(app, '/api/chat-queued-messages', { content: 'no session id at all' })

    expect((res as any).status).toBe(503)
    expect(handled).toHaveLength(0)
    expect(proxyCalls).toHaveLength(0)
  })

  test('a non-JSON body cannot name a workspace either', async () => {
    const { app, handled } = makeApp()
    const res = await app.request(
      new Request('https://us.studio.shogo.ai/api/chat-queued-messages', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'not json',
      }),
    )
    expect((res as any).status).toBe(503)
    expect(handled).toHaveLength(0)
  })

  test('it stays local when this region owns the session', async () => {
    // The guard must not break the region that does own the queue.
    const { app, handled } = makeApp()
    const body = { sessionId: 'sess_us', content: 'hi', body: 'hi' }
    const res = await post(app, '/api/chat-queued-messages', body)

    expect(proxyCalls).toHaveLength(0)
    expect((res as any).status).toBe(200)
    expect(handled).toEqual([body])
  })
})

describe('the inbox sync route is routed by its path', () => {
  test('POST /api/workspaces/:id/social/inbox/sync is proxied to the home region', async () => {
    const { app, handled } = makeApp()
    const res = await post(app, '/api/workspaces/ws_eu/social/inbox/sync', {})
    expect((res as any).status).toBe(299)
    expect(handled).toHaveLength(0)
    expect(proxyCalls[0].region).toBe('eu-frankfurt-1')
  })

  test('runs here when this region homes the workspace', async () => {
    const { app, handled } = makeApp()
    const res = await post(app, '/api/workspaces/ws_us/social/inbox/sync', {})
    expect(proxyCalls).toHaveLength(0)
    expect((res as any).status).toBe(200)
    expect(handled).toHaveLength(1)
  })
})

// Restore the env for any later test in this process.
process.env.HOME_REGION_ROUTING = SAVED_MODE
