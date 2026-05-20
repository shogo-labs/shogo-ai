// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ---- mocks ----
type StreamCb = (chunk: any) => void
const sendTunnelStreamCalls: any[] = []
const sendTunnelRequestCalls: any[] = []
const markControllerActiveCalls: any[] = []
let lastStreamCb: StreamCb | null = null
let lastStreamCancel = () => {}
let sendTunnelRequestImpl: (instId: string, req: any) => Promise<any> = async () => ({
  status: 200,
  body: '{"ok":true}',
  headers: { 'content-type': 'application/json' },
})
let markControllerActiveImpl: (instId: string, userId: string) => Promise<void> = async () => {}
let requestIdCounter = 0

mock.module('../../routes/instances', () => ({
  generateRequestId: () => `rid-${++requestIdCounter}`,
  markControllerActive: async (instId: string, userId: string) => {
    markControllerActiveCalls.push({ instId, userId })
    return markControllerActiveImpl(instId, userId)
  },
  sendTunnelRequest: async (instId: string, req: any) => {
    sendTunnelRequestCalls.push({ instId, req })
    return sendTunnelRequestImpl(instId, req)
  },
  sendTunnelStreamRequest: (instId: string, req: any, cb: StreamCb) => {
    sendTunnelStreamCalls.push({ instId, req })
    lastStreamCb = cb
    return { cancel: () => { lastStreamCancel() } }
  },
}))

const trackerCalls: any[] = []
let trackerImpl: (s: ReadableStream<Uint8Array>, p: string, c?: string | null) => Promise<void> = async () => {}
mock.module('../../lib/chat-usage-tracker', () => ({
  trackChatStreamForBilling: async (s: any, p: any, c: any) => {
    trackerCalls.push({ projectId: p, chatSessionId: c })
    return trackerImpl(s, p, c)
  },
}))

const { isAgentTunnelStreamingPath, relayAgentProxyViaTunnel } = await import('../tunnel-relay')

function makeCtx(opts: { signal?: AbortSignal; origin?: string } = {}) {
  const headers = new Map<string, string>()
  if (opts.origin) headers.set('origin', opts.origin)
  return {
    req: {
      raw: { signal: opts.signal } as any,
      header: (name: string) => headers.get(name.toLowerCase()),
    },
  } as any
}

beforeEach(() => {
  sendTunnelStreamCalls.length = 0
  sendTunnelRequestCalls.length = 0
  markControllerActiveCalls.length = 0
  trackerCalls.length = 0
  trackerImpl = async () => {}
  lastStreamCb = null
  lastStreamCancel = () => {}
  requestIdCounter = 0
  sendTunnelRequestImpl = async () => ({
    status: 200,
    body: '{"ok":true}',
    headers: { 'content-type': 'application/json' },
  })
})

afterEach(() => {})

describe('isAgentTunnelStreamingPath (pure)', () => {
  it('treats /agent/chat POST as streaming', () => {
    expect(isAgentTunnelStreamingPath('POST', '/agent/chat')).toBe(true)
  })
  it('treats /agent/quick-actions POST as streaming', () => {
    expect(isAgentTunnelStreamingPath('POST', '/agent/quick-actions')).toBe(true)
  })
  it('treats /agent/logs/stream GET as streaming and POST as non-streaming', () => {
    expect(isAgentTunnelStreamingPath('GET', '/agent/logs/stream')).toBe(true)
    expect(isAgentTunnelStreamingPath('POST', '/agent/logs/stream')).toBe(false)
  })
  it('rejects non-POST/GET methods', () => {
    expect(isAgentTunnelStreamingPath('PUT', '/agent/chat')).toBe(false)
    expect(isAgentTunnelStreamingPath('DELETE', '/agent/chat')).toBe(false)
  })
  it('rejects GET on non-logs path', () => {
    expect(isAgentTunnelStreamingPath('GET', '/agent/chat')).toBe(false)
  })
  it('rejects unknown paths', () => {
    expect(isAgentTunnelStreamingPath('POST', '/agent/random')).toBe(false)
  })
})

describe('relayAgentProxyViaTunnel — non-streaming', () => {
  it('forwards method/body/headers and returns JSON 200', async () => {
    const c = makeCtx({ origin: 'https://shogo.ai' })
    const r = await relayAgentProxyViaTunnel({
      c,
      instanceId: 'inst-1',
      workspaceId: 'w',
      projectId: 'p',
      agentPath: '/agent/users?x=1',
      cleanPath: '/agent/users',
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
      userId: 'u-1',
      authEmail: 'u@x.io',
      authName: 'U',
    })
    expect(r.status).toBe(200)
    const txt = await r.text()
    expect(txt).toContain('"ok":true')
    expect(sendTunnelRequestCalls).toHaveLength(1)
    const req = sendTunnelRequestCalls[0].req
    expect(req.method).toBe('POST')
    expect(req.path).toBe('/agent/users?x=1')
    expect(req.headers['x-tunnel-auth-user-id']).toBe('u-1')
    expect(req.headers['x-tunnel-auth-email']).toBe('u@x.io')
    expect(req.headers['x-tunnel-auth-name']).toBe('U')
    expect(markControllerActiveCalls).toEqual([{ instId: 'inst-1', userId: 'u-1' }])
    expect(r.headers.get('access-control-allow-origin')).toBe('https://shogo.ai')
    expect(r.headers.get('access-control-allow-credentials')).toBe('true')
    expect(r.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
  })

  it('uses wildcard CORS origin when no origin header', async () => {
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(),
      instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/x', cleanPath: '/agent/x', method: 'POST',
      headers: {},
    })
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(r.headers.get('access-control-allow-credentials')).toBe(null)
  })

  it('strips hop-by-hop headers and set-cookie from upstream response', async () => {
    sendTunnelRequestImpl = async () => ({
      status: 201,
      body: 'created',
      headers: {
        'content-type': 'text/plain',
        'transfer-encoding': 'chunked',
        connection: 'keep-alive',
        'set-cookie': 'evil=1',
        'x-custom': 'kept',
      },
    })
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(),
      instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/x', cleanPath: '/agent/x', method: 'POST',
      headers: {},
    })
    expect(r.status).toBe(201)
    expect(r.headers.get('transfer-encoding')).toBeNull()
    expect(r.headers.get('connection')).toBeNull()
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(r.headers.get('x-custom')).toBe('kept')
    expect(r.headers.get('content-type')).toBe('text/plain')
  })

  it('skips empty-string header values from upstream', async () => {
    sendTunnelRequestImpl = async () => ({
      status: 200, body: '', headers: { 'x-empty': '', 'x-set': 'v' },
    })
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(), instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/x', cleanPath: '/agent/x', method: 'POST', headers: {},
    })
    expect(r.headers.get('x-empty')).toBeNull()
    expect(r.headers.get('x-set')).toBe('v')
  })

  it('defaults content-type to application/json when missing from upstream', async () => {
    sendTunnelRequestImpl = async () => ({ status: 200, body: '{}', headers: {} })
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(), instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/x', cleanPath: '/agent/x', method: 'POST', headers: {},
    })
    expect(r.headers.get('content-type')).toBe('application/json')
  })

  it('returns 502 with proxy_error when tunnel throws', async () => {
    sendTunnelRequestImpl = async () => { throw new Error('tunnel offline') }
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(), instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/x', cleanPath: '/agent/x', method: 'POST', headers: {},
    })
    expect(r.status).toBe(502)
    const body = await r.json()
    expect(body.error.code).toBe('proxy_error')
    expect(body.error.message).toContain('tunnel offline')
  })

  it('returns 502 with default message when error has no message', async () => {
    sendTunnelRequestImpl = async () => { throw 'string error' as any }
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(), instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/x', cleanPath: '/agent/x', method: 'POST', headers: {},
    })
    expect(r.status).toBe(502)
    const body = await r.json()
    expect(body.error.message).toBe('Tunnel relay failed')
  })

  it('handles empty body from upstream', async () => {
    sendTunnelRequestImpl = async () => ({ status: 204, headers: {} })
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(), instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/x', cleanPath: '/agent/x', method: 'POST', headers: {},
    })
    expect(r.status).toBe(204)
    expect(await r.text()).toBe('')
  })

  it('skips markControllerActive when no userId', async () => {
    await relayAgentProxyViaTunnel({
      c: makeCtx(), instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/x', cleanPath: '/agent/x', method: 'POST', headers: {},
    })
    expect(markControllerActiveCalls).toHaveLength(0)
  })
})

describe('relayAgentProxyViaTunnel — streaming', () => {
  async function readAllChunks(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const parts: string[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(new TextDecoder().decode(value))
    }
    return parts
  }

  it('sets SSE headers and streams chunks to the response', async () => {
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx({ origin: 'https://x.io' }),
      instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/chat', cleanPath: '/agent/chat',
      method: 'POST', body: '{}', headers: {},
    })
    expect(r.headers.get('Content-Type')).toBe('text/event-stream')
    expect(r.headers.get('X-Accel-Buffering')).toBe('no')
    expect(r.headers.get('access-control-allow-origin')).toBe('https://x.io')
    expect(sendTunnelStreamCalls).toHaveLength(1)

    // Drive the stream
    setTimeout(() => {
      lastStreamCb?.({ type: 'stream-chunk', data: 'data: hello\n\n' })
      lastStreamCb?.({ type: 'stream-end' })
    }, 5)
    const parts = await readAllChunks(r.body as ReadableStream<Uint8Array>)
    expect(parts.join('')).toContain('hello')
  })

  it('propagates stream-error to the consumer', async () => {
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(),
      instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/chat', cleanPath: '/agent/chat',
      method: 'POST', headers: {},
    })
    setTimeout(() => {
      lastStreamCb?.({ type: 'stream-error', error: 'upstream blew up' })
    }, 5)
    const reader = (r.body as ReadableStream<Uint8Array>).getReader()
    let err: any
    await reader.read().catch((e) => (err = e))
    expect(String(err?.message ?? err)).toContain('upstream blew up')
  })

  it('propagates default stream-error message when none supplied', async () => {
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(),
      instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/chat', cleanPath: '/agent/chat',
      method: 'POST', headers: {},
    })
    setTimeout(() => lastStreamCb?.({ type: 'stream-error' }), 5)
    const reader = (r.body as ReadableStream<Uint8Array>).getReader()
    let err: any
    await reader.read().catch((e) => (err = e))
    expect(String(err?.message ?? err)).toContain('Stream error')
  })

  it('hands stream to tracker + invokes onBillingHandoff for chat turns', async () => {
    let handoffCalled = false
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(),
      instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/chat', cleanPath: '/agent/chat',
      method: 'POST', headers: {},
      isChatTurn: true,
      chatSessionId: 'sess-1',
      onBillingHandoff: () => { handoffCalled = true },
    })
    expect(handoffCalled).toBe(true)
    expect(trackerCalls).toEqual([{ projectId: 'p', chatSessionId: 'sess-1' }])
    setTimeout(() => {
      lastStreamCb?.({ type: 'stream-chunk', data: 'x' })
      lastStreamCb?.({ type: 'stream-end' })
    }, 5)
    await readAllChunks(r.body as ReadableStream<Uint8Array>)
  })

  it('accepts an explicit trackChatStream override (skips dynamic import)', async () => {
    let captured: any = null
    const customTracker = (stream: ReadableStream, projectId: string, csid?: string | null) => {
      captured = { projectId, csid }
      const reader = stream.getReader()
      void reader.read()
    }
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(),
      instanceId: 'i', workspaceId: 'w', projectId: 'pX',
      agentPath: '/agent/chat', cleanPath: '/agent/chat',
      method: 'POST', headers: {},
      isChatTurn: true, chatSessionId: 'sX',
      trackChatStream: customTracker,
    })
    expect(captured).toEqual({ projectId: 'pX', csid: 'sX' })
    expect(trackerCalls).toHaveLength(0)
    setTimeout(() => lastStreamCb?.({ type: 'stream-end' }), 5)
    await readAllChunks(r.body as ReadableStream<Uint8Array>)
  })

  it('logs but does not throw when tracker rejects', async () => {
    const origErr = console.error
    const errs: any[] = []
    console.error = (...a: any[]) => errs.push(a)
    try {
      trackerImpl = async () => { throw new Error('tracker died') }
      const r = await relayAgentProxyViaTunnel({
        c: makeCtx(),
        instanceId: 'i', workspaceId: 'w', projectId: 'p',
        agentPath: '/agent/chat', cleanPath: '/agent/chat',
        method: 'POST', headers: {},
        isChatTurn: true,
      })
      setTimeout(() => lastStreamCb?.({ type: 'stream-end' }), 5)
      await readAllChunks(r.body as ReadableStream<Uint8Array>)
      // Allow microtask + promise rejection to bubble
      await new Promise((r) => setTimeout(r, 20))
      expect(errs.some((e) => String(e[0]).includes('chat tracker error'))).toBe(true)
    } finally {
      console.error = origErr
    }
  })

  it('aborts via context signal → cancels tunnel and closes stream', async () => {
    let cancelled = false
    lastStreamCancel = () => { cancelled = true }
    const ac = new AbortController()
    // Need to install cancel BEFORE call — sendTunnelStreamRequest invocation uses lastStreamCancel as snapshot
    // so set it inside the mock override
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx({ signal: ac.signal }),
      instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/chat', cleanPath: '/agent/chat',
      method: 'POST', headers: {},
    })
    // Re-arm cancel after the relay call has installed the listener
    lastStreamCancel = () => { cancelled = true }
    ac.abort()
    const reader = (r.body as ReadableStream<Uint8Array>).getReader()
    await reader.read().catch(() => {})
    expect(cancelled).toBe(true)
  })

  it('closes trackerController when stream-error fires during a chat turn', async () => {
    // tracker is active (isChatTurn:true), then a stream-error chunk
    // forces the trackerController.close() path on line 201.
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(),
      instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/chat', cleanPath: '/agent/chat',
      method: 'POST', headers: {},
      isChatTurn: true,
      chatSessionId: 'sess-err',
    })
    expect(trackerCalls.length).toBeGreaterThan(0)
    setTimeout(() => {
      lastStreamCb?.({ type: 'stream-error', error: 'kaboom' })
    }, 5)
    const reader = (r.body as ReadableStream<Uint8Array>).getReader()
    let err: any
    await reader.read().catch((e) => (err = e))
    expect(String(err?.message ?? err)).toContain('kaboom')
  })

  it('closes trackerController when context signal aborts during a chat turn', async () => {
    // tracker active + signal abort → forces trackerController.close() on line 213.
    const ac = new AbortController()
    let cancelled = false
    lastStreamCancel = () => { cancelled = true }
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx({ signal: ac.signal }),
      instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/chat', cleanPath: '/agent/chat',
      method: 'POST', headers: {},
      isChatTurn: true,
      chatSessionId: 'sess-abort',
    })
    expect(trackerCalls.length).toBeGreaterThan(0)
    ac.abort()
    const reader = (r.body as ReadableStream<Uint8Array>).getReader()
    await reader.read().catch(() => {})
    expect(cancelled).toBe(true)
  })

  it('swallows markControllerActive rejections without breaking the relay', async () => {
    // forces line 139 markControllerActive(...).catch(() => {}) handler.
    markControllerActiveImpl = async () => { throw new Error('flaky kv') }
    try {
      const r = await relayAgentProxyViaTunnel({
        c: makeCtx(),
        instanceId: 'i', workspaceId: 'w', projectId: 'p',
        agentPath: '/agent/chat', cleanPath: '/agent/chat',
        method: 'POST', headers: {},
        userId: 'u-1',
      })
      setTimeout(() => lastStreamCb?.({ type: 'stream-end' }), 5)
      await readAllChunks(r.body as ReadableStream<Uint8Array>)
      expect(markControllerActiveCalls.length).toBeGreaterThan(0)
    } finally {
      markControllerActiveImpl = async () => {}
    }
  })

  it('handles non-chat streaming path without invoking tracker', async () => {
    const r = await relayAgentProxyViaTunnel({
      c: makeCtx(),
      instanceId: 'i', workspaceId: 'w', projectId: 'p',
      agentPath: '/agent/logs/stream', cleanPath: '/agent/logs/stream',
      method: 'GET', headers: {},
    })
    expect(r.headers.get('Content-Type')).toBe('text/event-stream')
    expect(trackerCalls).toHaveLength(0)
    setTimeout(() => lastStreamCb?.({ type: 'stream-end' }), 5)
    const reader = (r.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
  })
})
