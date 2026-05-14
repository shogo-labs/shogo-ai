// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const runtimeStatus = mock((_projectId: string) => ({ status: 'running', agentPort: 9123 }))
const runtimeStart = mock(async (_projectId: string) => ({ status: 'running', agentPort: 9124 }))
const getActiveProjects = mock(() => ['active-1'])
const wipeCloudKey = mock(async () => {})
const deriveRuntimeToken = mock((projectId: string) => `runtime-token-${projectId}`)

mock.module('../lib/runtime', () => ({
  getRuntimeManager: () => ({
    getActiveProjects,
    status: runtimeStatus,
    start: runtimeStart,
  }),
}))

mock.module('../lib/cloud-key-wipe', () => ({
  wipeCloudKey,
}))

mock.module('../lib/runtime-token', () => ({
  deriveRuntimeToken,
}))

const originalFetch = globalThis.fetch
const originalWebSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')

let fetchCalls: Array<{ url: string; init?: RequestInit }> = []
let fetchQueue: Array<() => Response | Promise<Response>> = []
let lastSocket: FakeWebSocket | null = null

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  closeCalls: Array<{ code?: number; reason?: string }> = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
  onerror: ((event: { message?: string }) => void) | null = null

  constructor(public url: string, public init: { headers: Record<string, string> }) {
    lastSocket = this
  }

  send(data: string) {
    this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason })
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: code ?? 1000, reason })
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  message(payload: unknown) {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) })
  }
}

const { startInstanceTunnel, stopInstanceTunnel, isTunnelConnected, _testing } = await import('../lib/instance-tunnel')

afterAll(() => {
  globalThis.fetch = originalFetch
  if (originalWebSocketDescriptor) {
    Object.defineProperty(globalThis, 'WebSocket', originalWebSocketDescriptor)
  }
  stopInstanceTunnel()
})

beforeEach(() => {
  stopInstanceTunnel()
  process.env.SHOGO_API_KEY = 'shogo_sk_test'
  process.env.SHOGO_CLOUD_URL = 'https://cloud.example/'
  delete process.env.SHOGO_TUNNEL_WS_URL
  delete process.env.SHOGO_INSTANCE_NAME
  delete process.env.PORT
  delete process.env.API_PORT
  Object.defineProperty(globalThis, 'WebSocket', {
    value: FakeWebSocket,
    configurable: true,
    writable: true,
  })
  fetchCalls = []
  fetchQueue = []
  lastSocket = null
  runtimeStatus.mockClear()
  runtimeStart.mockClear()
  getActiveProjects.mockClear()
  wipeCloudKey.mockClear()
  deriveRuntimeToken.mockClear()
  _testing.serverPublishedWsUrl = null
  _testing.wsReconnectAttempt = 0
  _testing.currentPollInterval = _testing.DEFAULT_POLL_INTERVAL_S
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    fetchCalls.push({ url, init })
    const next = fetchQueue.shift()
    return next ? await next() : new Response('{}', { status: 200 })
  }) as any
})

function sentMessages() {
  return (lastSocket?.sent ?? []).map((raw) => JSON.parse(raw))
}

async function markTunnelStarted() {
  fetchQueue.unshift(() => new Response(JSON.stringify({ nextPollIn: 60, wsRequested: false }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
  startInstanceTunnel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  fetchCalls = []
}

describe('instance tunnel heartbeat and websocket client', () => {
  test('sendHeartbeat posts instance metadata and caches cloud-published websocket URL', async () => {
    fetchQueue.push(() => new Response(JSON.stringify({
      instanceId: 'inst-1',
      nextPollIn: 7,
      wsRequested: true,
      wsUrl: 'wss://tunnel.example/',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await _testing.sendHeartbeat()

    expect(result.wsRequested).toBe(true)
    expect(_testing.serverPublishedWsUrl).toBe('wss://tunnel.example/')
    expect(fetchCalls[0].url).toBe('https://cloud.example/api/instances/heartbeat')
    const body = JSON.parse(String(fetchCalls[0].init?.body))
    // `collectMetadata()` in shogo-worker/lib/tunnel.ts populates these
    // fields. Note: there is no `apiPort` — desktop callers can plumb
    // their own ports in via the resolver, but the worker tunnel itself
    // does not advertise one.
    expect(body.metadata).toMatchObject({
      activeProjects: 1,
      protocolVersion: _testing.TUNNEL_PROTOCOL_VERSION,
      kind: 'desktop',
      tunnelStatus: 'polling',
    })
    expect(body.metadata.projects[0]).toMatchObject({ projectId: 'active-1', agentPort: 9123 })
  })

  test('connectWs opens with auth headers, answers pings, and forwards agent requests with runtime tokens', async () => {
    process.env.SHOGO_TUNNEL_WS_URL = 'wss://override.example/'
    process.env.SHOGO_INSTANCE_NAME = 'Desk One'
    fetchQueue.push(() => new Response('agent-ok', {
      status: 201,
      headers: { 'x-agent': 'yes' },
    }))

    await markTunnelStarted()
    _testing.connectWs()
    expect(lastSocket?.url).toBe('wss://override.example/api/instances/ws')
    expect(lastSocket?.init.headers).toMatchObject({
      Authorization: 'Bearer shogo_sk_test',
      'x-shogo-name': 'Desk One',
    })

    lastSocket!.open()
    lastSocket!.message({ type: 'ping' })
    lastSocket!.message({
      type: 'request',
      requestId: 'req-1',
      method: 'POST',
      path: '/agent/chat?x=1',
      projectId: 'proj-1',
      headers: { accept: 'application/json' },
      body: '{"hello":true}',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchCalls[0].url).toBe('http://localhost:9123/agent/chat?x=1')
    expect(fetchCalls[0].init?.method).toBe('POST')
    expect((fetchCalls[0].init?.headers as Record<string, string>)['x-runtime-token']).toBe('runtime-token-proj-1')
    expect(sentMessages()).toContainEqual({ type: 'pong' })
    expect(sentMessages()).toContainEqual({
      type: 'response',
      requestId: 'req-1',
      status: 201,
      headers: { 'x-agent': 'yes' },
      body: 'agent-ok',
    })
  })

  test('streams tunneled responses as chunks and end markers', async () => {
    fetchQueue.push(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello '))
        controller.enqueue(new TextEncoder().encode('stream'))
        controller.close()
      },
    })))

    await markTunnelStarted()
    _testing.connectWs()
    lastSocket!.open()
    lastSocket!.message({
      type: 'request',
      requestId: 'stream-1',
      method: 'GET',
      path: '/api/local/projects',
      stream: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchCalls[0].url).toBe('http://localhost:8002/api/local/projects')
    expect(sentMessages()).toEqual(expect.arrayContaining([
      { type: 'stream-chunk', requestId: 'stream-1', data: 'hello ' },
      { type: 'stream-chunk', requestId: 'stream-1', data: 'stream' },
      { type: 'stream-end', requestId: 'stream-1' },
    ]))
  })

  test('heartbeat auth failures wipe cloud key and back off after repeated failures', async () => {
    fetchQueue.push(
      () => new Response('nope', { status: 401 }),
      () => new Response('nope', { status: 403 }),
      () => new Response('nope', { status: 401 }),
    )

    startInstanceTunnel()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await _testing.heartbeatLoop()
    await _testing.heartbeatLoop()

    expect(wipeCloudKey).toHaveBeenCalledTimes(1)
    expect(_testing.currentPollInterval).toBe(300)
  })

  test('guards websocket header support and reports polling connectivity', async () => {
    expect(_testing.supportsWebSocketConstructorHeaders({})).toBe(false)
    expect(() => _testing.createTunnelWebSocket('wss://x', { headers: {} }, {})).toThrow('Tunnel WebSocket auth requires Bun')

    await markTunnelStarted()
    fetchQueue.push(
      () => new Response(JSON.stringify({ nextPollIn: 60, wsRequested: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      () => new Response(JSON.stringify({ nextPollIn: 60, wsRequested: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    await _testing.heartbeatLoop()
    await _testing.heartbeatLoop()
    expect(isTunnelConnected()).toBe(true)
  })

  test('ignores malformed and unknown websocket messages and handles close/error reconnect paths', async () => {
    await markTunnelStarted()
    _testing.connectWs()
    lastSocket!.open()

    lastSocket!.message('{not json')
    lastSocket!.message({ type: 'future-message' })
    lastSocket!.onerror?.({ message: 'socket boom' })
    expect(lastSocket!.sent).toEqual([])

    lastSocket!.onclose?.({ code: 4000, reason: 'session done' })
    expect(_testing.ws).toBeNull()
    expect(_testing.wsReconnectAttempt).toBe(0)

    await markTunnelStarted()
    _testing.connectWs()
    lastSocket!.open()
    lastSocket!.onclose?.({ code: 1006, reason: 'network reset' })
    expect(_testing.ws).toBeNull()
    expect(_testing.wsReconnectAttempt).toBe(1)
  })

  test('computes exponential websocket reconnect delay with capped jitter', () => {
    const originalRandom = Math.random
    Math.random = () => 0.5
    try {
      _testing.wsReconnectAttempt = 0
      expect(_testing.getReconnectDelay()).toBe(1100)

      _testing.wsReconnectAttempt = 10
      expect(_testing.getReconnectDelay()).toBe(66000)
    } finally {
      Math.random = originalRandom
    }
  })
})
