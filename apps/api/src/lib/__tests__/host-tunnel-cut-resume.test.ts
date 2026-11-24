// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A remote machine's chat turn survives a tunnel cut, and the client sees it end.
 *
 * Prod: the desktop tunnel WebSocket is closed by Knative's queue-proxy every
 * 300 s (`response.WriteHeader on hijacked connection` at each 1006), so any
 * turn longer than the time left on the socket loses its stream mid-turn. The
 * turn keeps running and finishes on the machine, but the client never resumed:
 * a tunnel stream carries no response headers, so `X-Turn-Id` never reached the
 * auto-resuming fetch, which then treated the chat as not resumable. The person
 * saw a reply that stopped and never completed.
 *
 * This drives the real `handleHostTunnel` route with the real client fetch
 * wrapper. The fake tunnel plays a runtime turn, cuts it with the same
 * `Tunnel disconnected` error a WebSocket close produces, and answers the resume
 * GET from the runtime's buffer. Runs in well under a second.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { createAutoResumingFetch } from '../../../../../packages/shared-app/src/chat/auto-resuming-fetch'

mock.module('../prisma', () => ({
  prisma: {
    workspace: { findUnique: async () => ({ hostInstanceId: 'inst-1' }) },
    project: { findUnique: async () => null },
    instance: {
      findUnique: async (args: any) =>
        args?.where?.id === 'inst-1' ? { id: 'inst-1', name: 'Studio Mac', userId: 'user-1' } : null,
    },
  },
}))

const { handleHostTunnel, hostTunnelRuntimeUrl, _resetHostCacheForTests } = await import('../host-tunnel')

const SESSION = 'sess-1'
const TURN = 'turn-abc'

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

/** The runtime's buffered turn: every frame with the seq it was buffered at. */
const TURN_FRAMES: Array<{ seq: number; data: string }> = [
  { seq: 1, data: sse({ type: 'data-turn-start', data: { turnId: TURN, chatSessionId: SESSION, startedAt: 1 } }) },
  { seq: 2, data: sse({ type: 'start-step' }) },
  { seq: 3, data: sse({ type: 'text-start', id: 't1' }) },
  { seq: 4, data: sse({ type: 'text-delta', id: 't1', delta: 'Working on it. ' }) },
  { seq: 4, data: sse({ type: 'data-turn-seq', data: { seq: 4 }, transient: true }) },
  // ── the tunnel WebSocket is closed here ──
  { seq: 5, data: sse({ type: 'text-delta', id: 't1', delta: 'All done.' }) },
  { seq: 6, data: sse({ type: 'text-end', id: 't1' }) },
  { seq: 7, data: sse({ type: 'finish-step' }) },
  { seq: 8, data: sse({ type: 'data-turn-complete', data: { turnId: TURN, status: 'completed' } }) },
  { seq: 9, data: sse({ type: 'finish' }) },
]
const CUT_AFTER_SEQ = 4

const calls: Array<{ method: string; path: string }> = []

const tunnel = {
  ensureTunnelConnected: async () => true,
  sendTunnelRequest: async () => ({ status: 200, headers: {}, body: '{}' }),
  sendTunnelStreamRequest: (_instanceId: string, payload: any, onChunk: (chunk: any) => void) => {
    calls.push({ method: payload.method, path: payload.path })
    queueMicrotask(() => {
      if (payload.method === 'POST') {
        for (const f of TURN_FRAMES) {
          if (f.seq > CUT_AFTER_SEQ) break
          onChunk({ type: 'stream-chunk', requestId: payload.requestId, data: f.data })
        }
        // What `handleInstanceWsClose` sends every open stream, a moment after
        // the frames above reached the client.
        setTimeout(
          () => onChunk({ type: 'stream-error', requestId: payload.requestId, error: 'Tunnel disconnected' }),
          5,
        )
        return
      }
      const fromSeq = Number(new URL(payload.path, 'http://x').searchParams.get('fromSeq') ?? 0)
      for (const f of TURN_FRAMES) {
        if (f.seq > fromSeq) onChunk({ type: 'stream-chunk', requestId: payload.requestId, data: f.data })
      }
      onChunk({ type: 'stream-end', requestId: payload.requestId })
    })
    return { cancel() {} }
  },
  generateRequestId: () => `req-${calls.length + 1}`,
}

const secret = new URL(hostTunnelRuntimeUrl('inst-1', { workspaceId: 'ws-1' })).pathname.split('/')[4]
const CHAT_URL = `http://api.test/api/internal/host-tunnel/${secret}/inst-1/api/workspaces/ws-1/agent-proxy/agent/chat`

function app() {
  const a = new Hono()
  a.all('/api/internal/host-tunnel/*', (c) =>
    handleHostTunnel(c, { _peerAddress: '127.0.0.1', _hostOf: async () => 'inst-1', _tunnel: tunnel }),
  )
  return a
}

async function readAll(res: Response): Promise<{ text: string; error: string | null }> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch (err: any) {
    return { text, error: err?.message ?? String(err) }
  }
  return { text, error: null }
}

beforeEach(() => {
  _resetHostCacheForTests()
  calls.length = 0
})

describe('remote machine chat: a tunnel cut mid-turn', () => {
  test('the tunnel stream carries no X-Turn-Id (why the client never resumed)', async () => {
    const res = await app().request(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chat-session-id': SESSION },
      body: '{}',
    })
    expect(res.headers.get('x-turn-id')).toBeNull()
    await readAll(res)
  })

  test('the client resumes from the buffer and sees the turn complete', async () => {
    const a = app()
    const base: typeof fetch = (async (input: any, init?: RequestInit) =>
      a.request(typeof input === 'string' ? input : input.url, init)) as any
    const client = createAutoResumingFetch(base, { logger: null, initialBackoffMs: 1, maxBackoffMs: 1 })

    const res = await client(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Chat-Session-Id': SESSION },
      body: '{}',
    })
    const { text, error } = await readAll(res)

    expect(error).toBeNull()
    expect(text).toContain('All done.')
    expect(text).toContain('data-turn-complete')
    // One resume, from the last seq the client saw — no replay of what it has.
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET'])
    expect(calls[1].path).toBe(`/api/workspaces/ws-1/agent-proxy/agent/chat/${SESSION}/stream?fromSeq=${CUT_AFTER_SEQ}`)
    expect(text.match(/Working on it\./g)).toHaveLength(1)
  })
})
