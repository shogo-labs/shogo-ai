// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Extra coverage for src/lib/instance-tunnel.ts:
//   - desktopResolver error paths (lines 84-95, 113, 123)
//   - startInstanceTunnel restart branch (lines 155-156)
//   - getOrCreateTunnel branch when SHOGO_API_KEY is unset
//   - status() null pass-through, resetForTests no-op path

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// Per-test mock state — same pattern as the existing instance-tunnel.test.ts.
const runtimeStatus = mock((_projectId: string): { status: string; agentPort: number | null } | null => ({ status: 'running', agentPort: 9123 }))
const runtimeStart = mock(async (_projectId: string) => ({ status: 'running', agentPort: 9124 }))
const getActiveProjects = mock((): string[] => ['active-1'])
const wipeCloudKey = mock(async () => {})
const deriveProjectRuntimeToken = mock(async (projectId: string): Promise<string> => `runtime-token-${projectId}`)

// Toggle: when true, getRuntimeManager() throws (simulates "no manager
// available" — exercises the outer catch in resolveLocalUrl + the
// catch in getActiveProjects/status).
let runtimeManagerThrows = false

mock.module('../lib/runtime', () => ({
  getRuntimeManager: () => {
    if (runtimeManagerThrows) throw new Error('runtime manager unavailable')
    return {
      getActiveProjects,
      status: runtimeStatus,
      start: runtimeStart,
    }
  },
}))

mock.module('../lib/cloud-key-wipe', () => ({ wipeCloudKey }))
mock.module('../lib/project-runtime-token', () => ({ deriveProjectRuntimeToken }))

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
  send(data: string) { this.sent.push(data) }
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

// The live tunnel's threading has its own test; these drive the protocol, which
// needs the socket on this thread (a fake `WebSocket` cannot reach a worker).
const { startInstanceTunnel, stopInstanceTunnel, isTunnelConnected, _testing } = await import('../lib/instance-tunnel')
_testing.forceInProcess()

afterAll(() => {
  globalThis.fetch = originalFetch
  if (originalWebSocketDescriptor) {
    Object.defineProperty(globalThis, 'WebSocket', originalWebSocketDescriptor)
  }
  stopInstanceTunnel()
})

beforeEach(() => {
  stopInstanceTunnel()
  runtimeManagerThrows = false
  process.env.SHOGO_API_KEY = 'shogo_sk_test'
  process.env.SHOGO_CLOUD_URL = 'https://cloud.example/'
  delete process.env.SHOGO_TUNNEL_WS_URL
  delete process.env.SHOGO_INSTANCE_NAME
  delete process.env.PORT
  delete process.env.API_PORT
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true })
  fetchCalls = []
  fetchQueue = []
  lastSocket = null
  runtimeStatus.mockReset()
  runtimeStatus.mockImplementation(() => ({ status: 'running', agentPort: 9123 }))
  runtimeStart.mockReset()
  runtimeStart.mockImplementation(async () => ({ status: 'running', agentPort: 9124 }))
  getActiveProjects.mockReset()
  getActiveProjects.mockImplementation(() => ['active-1'])
  wipeCloudKey.mockClear()
  deriveProjectRuntimeToken.mockClear()
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

/**
 * What the tunnel forwarded to a local runtime or to the local API — i.e. every
 * `fetch` except its own heartbeats to the cloud.
 *
 * These tests run the tunnel on this thread (§5's threading has its own test),
 * so its heartbeat goes through the same mocked `fetch`. Asserting on
 * `fetchCalls[0]` made the result depend on whether a heartbeat happened to land
 * first, which is why one of them counted a heartbeat as a forwarded request.
 */
function forwardedRequests(): Array<{ url: string; init?: RequestInit }> {
  return fetchCalls.filter((call) => call.url.startsWith('http://localhost:'))
}

describe('desktopResolver — error paths', () => {
  test('agent path with a stopped runtime: starts it in the background and answers RUNTIME_STARTING', async () => {
    // Never await a cold start inside a tunnel request: `manager.start()` blocks
    // the local API's event loop (lsof/ps), and this tunnel shares that loop, so
    // `/health` stopped answering and the desktop supervisor killed the API
    // mid-request — the tunnel then dropped as 1006 at the cloud (SHO-185).
    runtimeStatus.mockImplementation(() => ({ status: 'stopped', agentPort: null }))
    runtimeStart.mockImplementation(async () => { throw new Error('cold start failed') })

    await markTunnelStarted()
    _testing.connectWs()
    lastSocket!.open()
    lastSocket!.message({
      type: 'request',
      requestId: 'req-err-1',
      method: 'GET',
      path: '/agent/chat',
      projectId: 'proj-broken',
    })
    await new Promise((r) => setTimeout(r, 0))

    // Nothing is forwarded to the local API, and the cloud is told to retry.
    expect(forwardedRequests()).toEqual([])
    const reply = lastSocket!.sent.map((frame) => JSON.parse(frame)).find((f) => f.requestId === 'req-err-1')
    expect(reply.status).toBe(502)
    expect(reply.body).toContain('RUNTIME_STARTING')
  })

  test('agent path with no projectId: iterates active projects, skips failing ones', async () => {
    getActiveProjects.mockImplementation(() => ['bad-1', 'good-1'])
    runtimeStatus.mockImplementation((pid: string) =>
      pid === 'good-1' ? { status: 'running', agentPort: 9555 } : { status: 'stopped', agentPort: null },
    )
    runtimeStart.mockImplementation(async (pid: string) => {
      if (pid === 'bad-1') throw new Error('bad-1 start failed')
      return { status: 'running', agentPort: 9555 }
    })

    await markTunnelStarted()
    _testing.connectWs()
    lastSocket!.open()
    lastSocket!.message({
      type: 'request',
      requestId: 'req-err-2',
      method: 'GET',
      path: '/agent/chat',
      // no projectId — falls through to manager.getActiveProjects()
    })
    await new Promise((r) => setTimeout(r, 0))

    // Only runtimes that are already running are used: bad-1 is stopped and is
    // skipped without being started (starting every project to answer one
    // request is what blocked the loop), good-1 already runs → its agentPort.
    expect(forwardedRequests()[0].url).toBe('http://localhost:9555/agent/chat')
    expect(runtimeStart).not.toHaveBeenCalled()
  })

  test('agent path: outer catch when getRuntimeManager itself throws → falls back to apps/api', async () => {
    runtimeManagerThrows = true

    await markTunnelStarted()
    _testing.connectWs()
    lastSocket!.open()
    lastSocket!.message({
      type: 'request',
      requestId: 'req-err-3',
      method: 'GET',
      path: '/agent/anything',
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(forwardedRequests()[0].url).toBe('http://localhost:39100/agent/anything')
  })

  test('agent path: a runtime with no agentPort is reported as starting, not forwarded', async () => {
    runtimeStatus.mockImplementation(() => null)
    runtimeStart.mockImplementation(async () => ({ status: 'starting', agentPort: null }) as any)

    await markTunnelStarted()
    _testing.connectWs()
    lastSocket!.open()
    lastSocket!.message({
      type: 'request',
      requestId: 'req-err-4',
      method: 'GET',
      path: '/agent/x',
      projectId: 'proj-coldstart',
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(forwardedRequests()).toEqual([])
    const reply = lastSocket!.sent.map((frame) => JSON.parse(frame)).find((f) => f.requestId === 'req-err-4')
    expect(reply.status).toBe(502)
    expect(reply.body).toContain('RUNTIME_STARTING')
  })

  test('non-agent path always forwards to apps/api (PORT env override is honored)', async () => {
    process.env.PORT = '9090'
    // Force a fresh tunnel since `getApiPort()` is read inside the resolver, but
    // the tunnel singleton is reused — restart to be safe.
    stopInstanceTunnel()
    await markTunnelStarted()
    _testing.connectWs()
    lastSocket!.open()
    lastSocket!.message({
      type: 'request',
      requestId: 'req-non-agent',
      method: 'GET',
      path: '/api/local/projects?limit=5',
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(forwardedRequests()[0].url).toBe('http://localhost:9090/api/local/projects?limit=5')
  })

  test('exact "/agent" path (no trailing slash) is treated as an agent path', async () => {
    await markTunnelStarted()
    _testing.connectWs()
    lastSocket!.open()
    lastSocket!.message({
      type: 'request',
      requestId: 'req-bare-agent',
      method: 'GET',
      path: '/agent',
      projectId: 'proj-bare',
    })
    await new Promise((r) => setTimeout(r, 0))

    // status() returns running with port 9123 → forwarded to that port.
    expect(forwardedRequests()[0].url).toBe('http://localhost:9123/agent')
  })
})

describe('startInstanceTunnel / stopInstanceTunnel — lifecycle branches', () => {
  test('no-op when SHOGO_API_KEY is absent (lines 142-146)', () => {
    delete process.env.SHOGO_API_KEY
    // Should not throw, should not start any polling.
    startInstanceTunnel()
    expect(isTunnelConnected()).toBe(false)
  })

  test('restart path: a second startInstanceTunnel() call replaces the active tunnel (lines 155-156)', async () => {
    await markTunnelStarted()
    const firstTunnel = _testing.tunnel
    // Second call must dispose the old tunnel and mint a new one.
    fetchQueue.unshift(() => new Response(JSON.stringify({ nextPollIn: 60, wsRequested: false }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    startInstanceTunnel()
    await new Promise((r) => setTimeout(r, 0))
    const secondTunnel = _testing.tunnel
    expect(secondTunnel).not.toBe(firstTunnel)
  })

  test('stopInstanceTunnel is a safe no-op when no tunnel is active', () => {
    stopInstanceTunnel()
    stopInstanceTunnel()
    expect(isTunnelConnected()).toBe(false)
  })

  test('isTunnelConnected returns false when no tunnel exists', () => {
    expect(isTunnelConnected()).toBe(false)
  })
})

describe('_testing.resetForTests', () => {
  test('safely no-ops when no tunnel exists', () => {
    _testing.resetForTests()
    expect(isTunnelConnected()).toBe(false)
  })

  test('discards the active tunnel — subsequent reads see a fresh instance', async () => {
    await markTunnelStarted()
    const first = _testing.tunnel
    _testing.resetForTests()
    const second = _testing.tunnel
    expect(second).not.toBe(first)
  })
})
