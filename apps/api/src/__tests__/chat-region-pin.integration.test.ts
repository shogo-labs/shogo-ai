// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end integration proof for chat-session region pinning (P1) and the
 * hardened client resume (P0), exercised over REAL HTTP with REAL streaming.
 *
 * Unlike the unit tests (which stub proxyToPeer), this boots two live Bun HTTP
 * servers:
 *
 *   - "home"  — the region that owns the turn's in-memory stream buffer. It is
 *               the ONLY server that can serve the buffered turn body.
 *   - "edge"  — a different region the request happens to land on (Cloudflare
 *               geo-steer / dropped affinity cookie). Its chat routes call the
 *               real `pinChatToHomeRegion`, which uses the real `proxyToPeer`
 *               (real cross-process fetch) to forward to "home".
 *
 * Only prisma is mocked (it's just the project→workspace→homeRegion lookup);
 * the region config, proxy, loop guard, SSE streaming and the client's
 * auto-resume are all the real code paths.
 *
 *   bun test apps/api/src/__tests__/chat-region-pin.integration.test.ts
 */

import { describe, test, expect, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'
import { createAutoResumingFetch } from '../../../../packages/shared-app/src/chat/auto-resuming-fetch'

const SILENT_LOGGER = { warn: () => {}, log: () => {} }

const HOME_REGION = 'home-1'
const EDGE_REGION = 'edge-1'
const DEAD_REGION = 'dead-1'
const NOPEER_REGION = 'ghost-9'

const TURN_ID = 'turn_integration_1'
const SESSION_ID = 'sess_integration_1'

const enc = new TextEncoder()
function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    },
  })
}
async function readAll(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return ''
  const reader = body.getReader()
  const dec = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) out += dec.decode(value, { stream: true })
  }
  return out + dec.decode()
}

// ─── The HOME region server (owns the buffer) ──────────────────────────────
// Records what it received so we can assert the proxy forwarded the loop-guard
// header + the caller's cookie.
const homeSeen: Array<{ method: string; proxied: boolean; cookie: string; fromSeq: string | null }> = []

const homeApp = new Hono()
// Initial turn POST: emits a partial stream that ends WITHOUT turn-complete
// (an HTTP/2 reset / activator cut), leaving the rest on the buffer.
homeApp.post('/api/projects/:projectId/chat', (c) => {
  homeSeen.push({
    method: 'POST',
    proxied: c.req.header('x-shogo-home-region-proxy') === '1',
    cookie: c.req.header('cookie') || '',
    fromSeq: null,
  })
  const body = sseStream([
    frame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID, startedAt: 1 } }),
    frame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 5 } }),
    frame({ type: 'text-delta', delta: 'PARTIAL_FROM_HOME' }),
    // no data-turn-complete → the client will auto-resume.
  ])
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Turn-Id': TURN_ID,
      'X-Chat-Session-Id': SESSION_ID,
    },
  })
})
// Resume: serve the buffered tail + terminal marker from the owning region.
homeApp.get('/api/projects/:projectId/chat/:sid/stream', (c) => {
  homeSeen.push({
    method: 'GET',
    proxied: c.req.header('x-shogo-home-region-proxy') === '1',
    cookie: c.req.header('cookie') || '',
    fromSeq: c.req.query('fromSeq') ?? null,
  })
  const body = sseStream([
    frame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 9 } }),
    frame({ type: 'text-delta', delta: 'RESUMED_FROM_HOME' }),
    frame({ type: 'data-turn-complete', data: { turnId: TURN_ID, status: 'completed', lastSeq: 9 } }),
  ])
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'X-Turn-Id': TURN_ID },
  })
})

const homeServer = Bun.serve({ port: 0, fetch: homeApp.fetch })
const HOME_URL = `http://127.0.0.1:${homeServer.port}`

// ─── Region + prisma config for the EDGE process (set BEFORE importing) ─────
process.env.REGION_ID = EDGE_REGION
process.env.REGION_PEERS = JSON.stringify([
  { id: HOME_REGION, label: 'Home', url: HOME_URL },
  // Configured peer that is DOWN (connection refused) — for fail-closed test.
  { id: DEAD_REGION, label: 'Dead', url: 'http://127.0.0.1:9' },
])
process.env.HOST_HEADER_FOR_PEERS = 'studio.shogo.ai'
delete process.env.CHAT_REGION_PIN

// project → workspace → homeRegion fixtures.
const projects: Record<string, { workspaceId: string } | null> = {
  p_home: { workspaceId: 'ws_home' }, // owned by the home region (peer) → proxy
  p_local: { workspaceId: 'ws_local' }, // owned by THIS edge region → local
  p_dead: { workspaceId: 'ws_dead' }, // peer configured but unreachable → 503
  p_nopeer: { workspaceId: 'ws_nopeer' }, // home region has no peer route → 503
  p_missing: null, // unknown project → local
}
const workspaces: Record<string, { homeRegion: string | null } | null> = {
  ws_home: { homeRegion: HOME_REGION },
  ws_local: { homeRegion: EDGE_REGION },
  ws_dead: { homeRegion: DEAD_REGION },
  ws_nopeer: { homeRegion: NOPEER_REGION },
}
mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id in projects ? projects[id] : null,
    },
    workspace: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id in workspaces ? workspaces[id] : null,
    },
  },
}))

// Import the REAL helper (which pulls in the REAL region + proxy) now that env
// + prisma mock are in place.
const { pinChatToHomeRegion } = await import('../lib/chat-region-pin')

// ─── The EDGE region server (real pin → real proxy) ─────────────────────────
const edgeApp = new Hono()
edgeApp.post('/api/projects/:projectId/chat', async (c) => {
  const pinned = await pinChatToHomeRegion(c, c.req.param('projectId'))
  if (pinned) return pinned
  // Local (same-region) serve — a bare stub so we can tell it apart.
  return c.text('EDGE_LOCAL_POST', 418)
})
edgeApp.get('/api/projects/:projectId/chat/:sid/stream', async (c) => {
  const pinned = await pinChatToHomeRegion(c, c.req.param('projectId'))
  if (pinned) return pinned
  // Local serve: the edge region has no buffer for a home-region turn. In the
  // real app this is the 204/404 that used to trigger the resume storm.
  return c.text('EDGE_LOCAL_NO_BUFFER', 404)
})

const edgeServer = Bun.serve({ port: 0, fetch: edgeApp.fetch })
const EDGE_URL = `http://127.0.0.1:${edgeServer.port}`

afterAll(() => {
  homeServer.stop(true)
  edgeServer.stop(true)
})

describe('chat region pinning — real cross-region HTTP proxy (P1)', () => {
  test('a resume landing on the edge region is transparently served by the home buffer', async () => {
    homeSeen.length = 0
    const res = await fetch(
      `${EDGE_URL}/api/projects/p_home/chat/${SESSION_ID}/stream?fromSeq=5`,
      { headers: { Cookie: '__cflb=affinitycookie; shogo.session_token=abc' } },
    )
    expect(res.status).toBe(200)
    // The turn header from the HOME region flows back through the edge proxy.
    expect(res.headers.get('X-Turn-Id')).toBe(TURN_ID)
    const text = await readAll(res.body)
    expect(text).toContain('RESUMED_FROM_HOME')
    expect(text).toContain('data-turn-complete')

    // The home region actually received the (proxied) request, with the loop
    // guard set and the caller's cookie forwarded, at the requested fromSeq.
    expect(homeSeen).toHaveLength(1)
    expect(homeSeen[0].method).toBe('GET')
    expect(homeSeen[0].proxied).toBe(true)
    expect(homeSeen[0].cookie).toContain('__cflb=affinitycookie')
    expect(homeSeen[0].fromSeq).toBe('5')
  })

  test('a same-region resume is served locally (never proxied)', async () => {
    homeSeen.length = 0
    const res = await fetch(`${EDGE_URL}/api/projects/p_local/chat/${SESSION_ID}/stream?fromSeq=0`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('EDGE_LOCAL_NO_BUFFER')
    expect(homeSeen).toHaveLength(0)
  })

  test('an already-proxied request (loop guard) is handled locally, never re-proxied', async () => {
    homeSeen.length = 0
    const res = await fetch(`${EDGE_URL}/api/projects/p_home/chat/${SESSION_ID}/stream?fromSeq=0`, {
      headers: { 'x-shogo-home-region-proxy': '1' },
    })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('EDGE_LOCAL_NO_BUFFER')
    expect(homeSeen).toHaveLength(0)
  })

  test('fails closed with a retryable 503 when the home peer is unreachable', async () => {
    const res = await fetch(`${EDGE_URL}/api/projects/p_dead/chat/${SESSION_ID}/stream?fromSeq=0`)
    expect(res.status).toBe(503)
    const body = (await res.json()) as any
    expect(body?.error?.code).toBe('home_region_unavailable')
    expect(body?.error?.retryable).toBe(true)
  })

  test('fails closed with a 503 when no peer is configured for the home region', async () => {
    const res = await fetch(`${EDGE_URL}/api/projects/p_nopeer/chat/${SESSION_ID}/stream?fromSeq=0`)
    expect(res.status).toBe(503)
  })

  test('unknown project falls through to local handling (no proxy)', async () => {
    homeSeen.length = 0
    const res = await fetch(`${EDGE_URL}/api/projects/p_missing/chat/${SESSION_ID}/stream?fromSeq=0`)
    expect(res.status).toBe(404)
    expect(homeSeen).toHaveLength(0)
  })

  test('kill switch CHAT_REGION_PIN=off disables pinning (serve locally)', async () => {
    homeSeen.length = 0
    process.env.CHAT_REGION_PIN = 'off'
    try {
      const res = await fetch(`${EDGE_URL}/api/projects/p_home/chat/${SESSION_ID}/stream?fromSeq=0`)
      expect(res.status).toBe(404)
      expect(homeSeen).toHaveLength(0)
    } finally {
      delete process.env.CHAT_REGION_PIN
    }
  })
})

describe('client auto-resume + server region-pin, end to end (P0 + P1)', () => {
  test('an interrupted turn on the edge region resumes transparently from the home buffer', async () => {
    homeSeen.length = 0
    // The REAL hardened client wrapper over the global fetch. Its POST goes to
    // the edge, is pinned to the home region (partial stream, no complete);
    // on EOF the client auto-resumes to the edge, which pins the resume to the
    // home buffer that streams the tail + terminal marker.
    const client = createAutoResumingFetch(globalThis.fetch.bind(globalThis), {
      logger: SILENT_LOGGER,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
    })

    const res = await client(`${EDGE_URL}/api/projects/p_home/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: '__cflb=affinitycookie' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)

    const text = await readAll(res.body)
    // The client stitched the partial POST body and the resumed tail into one
    // continuous stream — the AI SDK never sees the disconnect.
    expect(text).toContain('PARTIAL_FROM_HOME')
    expect(text).toContain('RESUMED_FROM_HOME')
    expect(text).toContain('data-turn-complete')

    // Both the initial POST and the resume GET were proxied to the home region
    // (whole session coherent in one region) — exactly one resume attempt.
    const posts = homeSeen.filter((s) => s.method === 'POST')
    const gets = homeSeen.filter((s) => s.method === 'GET')
    expect(posts).toHaveLength(1)
    expect(gets).toHaveLength(1)
    expect(posts[0].proxied).toBe(true)
    expect(gets[0].proxied).toBe(true)
    // Resume asked for bytes after the last seq the client saw on the POST.
    // (The affinity-cookie forwarding is a browser cookie-jar behaviour driven
    // by the forwarded `credentials` mode — proven at the proxy layer by the
    // explicit-Cookie test above and at the client layer by the unit test
    // "forwards the request credentials mode onto the internal resume GET".)
    expect(gets[0].fromSeq).toBe('5')
  })

  test('does not storm the endpoint when the resume region returns a hard 404', async () => {
    // Point the client at a project owned by THIS edge region: the edge serves
    // the resume locally and (having no buffer) 404s. The P0 client must treat
    // that as terminal — exactly one resume attempt, no loop.
    let resumeHits = 0
    const countingFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'GET' && url.includes('/stream')) resumeHits++
      return globalThis.fetch(input as any, init)
    }
    // Make the edge POST return a partial (no complete) for p_local so the
    // client is forced to attempt a resume.
    const localEdge = new Hono()
    localEdge.post('/api/projects/:projectId/chat', () =>
      new Response(
        sseStream([
          frame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID, startedAt: 1 } }),
          frame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 2 } }),
          frame({ type: 'text-delta', delta: 'PARTIAL' }),
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Turn-Id': TURN_ID, 'X-Chat-Session-Id': SESSION_ID } },
      ),
    )
    localEdge.get('/api/projects/:projectId/chat/:sid/stream', (c) => c.text('404 Not Found', 404))
    const localServer = Bun.serve({ port: 0, fetch: localEdge.fetch })
    try {
      const client = createAutoResumingFetch(countingFetch, {
        logger: SILENT_LOGGER,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        maxResumeAttempts: 8,
      })
      const res = await client(`http://127.0.0.1:${localServer.port}/api/projects/p_local/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      await readAll(res.body)
      expect(resumeHits).toBe(1)
    } finally {
      localServer.stop(true)
    }
  })
})
