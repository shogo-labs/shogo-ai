// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-538 — a hosted-workspace call may not outlive Cloudflare's edge.
 *
 * The desktop's tunnel closes after five idle minutes and only learns the cloud
 * wants it back from its next heartbeat poll (60 s when idle). `handleHostTunnel`
 * waited out that whole poll (up to `WAKE_MAX_WAIT_MS`, 75 s) and *then* ran the
 * request on top of it (up to `PROXY_TIMEOUT_MS`, 30 s) with no bytes sent in
 * between — 105 s, so Cloudflare answered 524 before this process said anything.
 *
 * Now the wake is capped at the interactive window and the request gets only what
 * is left of one edge budget, so every path answers inside it: `503
 * host_connecting` for a host still opening, `504 host_runtime_starting` for one
 * that did not answer in time, and — for a stream — the `text/event-stream`
 * headers *before* the wake, with a failed wake as an SSE error frame.
 *
 * The windows are set through their env vars before the module is imported, so
 * the assertions are real elapsed times on a small clock rather than 90 s.
 *
 *   bun test apps/api/src/lib/__tests__/host-tunnel-budget.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const WAKE_WINDOW_MS = 250
const EDGE_BUDGET_MS = 600
const STALE_PROBE_MS = 100

process.env.SHOGO_HOST_WAKE_INTERACTIVE_MS = String(WAKE_WINDOW_MS)
process.env.SHOGO_EDGE_RESPONSE_BUDGET_MS = String(EDGE_BUDGET_MS)
process.env.SHOGO_HOST_WAKE_DEADLINE_MS = String(STALE_PROBE_MS)

const state: {
  instance: { id: string; name: string; userId: string | null } | null
  project: { id: string; workspaceId: string } | null
  /** What the fake wake is told, and what it answers. */
  wakeCalls: Array<{ instanceId: string; opts?: { staleProbeMs?: number; maxWaitMs?: number } }>
  wakeState: 'connected' | 'connecting' | 'offline'
  /** How long the fake wake takes, inside its own `maxWaitMs` like the real one. */
  wakeMs: number
  /** Ignore `maxWaitMs` — a wake that overruns its cap, to exercise the budget guard. */
  wakeOverrun: boolean
  forwarded: Array<{ instanceId: string; payload: any }>
  streamed: Array<{ instanceId: string; payload: any }>
  /** A tunnel reply that never arrives, for the budget case. */
  replyMs: number | null
} = {
  instance: { id: 'inst-1', name: 'Studio Mac', userId: 'user-1' },
  project: { id: 'proj-1', workspaceId: 'ws-1' },
  wakeCalls: [],
  wakeState: 'connected',
  wakeMs: 0,
  wakeOverrun: false,
  forwarded: [],
  streamed: [],
  replyMs: null,
}

mock.module('../prisma', () => ({
  prisma: {
    workspace: { findUnique: async () => ({ hostInstanceId: 'inst-1' }) },
    project: {
      findUnique: async (args: any) =>
        state.project && state.project.id === args?.where?.id ? state.project : null,
    },
    instance: {
      findUnique: async (args: any) =>
        state.instance && state.instance.id === args?.where?.id ? state.instance : null,
    },
  },
}))

const { handleHostTunnel, hostTunnelRuntimeUrl, _resetHostCacheForTests } = await import('../host-tunnel')

const secret = new URL(hostTunnelRuntimeUrl('inst-1', { workspaceId: 'ws-1' })).pathname.split('/')[4]
const PLANS = '/api/workspaces/ws-1/agent-proxy/agent/plans'
const RESUME = '/api/workspaces/ws-1/agent-proxy/agent/chat/chat-1/stream'

function tunnelPath(rest: string): string {
  return `/api/internal/host-tunnel/${secret}/inst-1${rest}`
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const tunnel = {
  async wakeHostTunnel(instanceId: string, opts?: { staleProbeMs?: number; maxWaitMs?: number }) {
    state.wakeCalls.push({ instanceId, opts })
    if (state.wakeMs > 0) {
      await sleep(state.wakeOverrun ? state.wakeMs : Math.min(state.wakeMs, opts?.maxWaitMs ?? state.wakeMs))
    }
    return {
      state: state.wakeState,
      instanceId,
      name: 'Studio Mac',
      lastSeenAt: new Date(Date.now() - 40_000),
      retryAfterSeconds: state.wakeState === 'connecting' ? 15 : 0,
    }
  },
  async sendTunnelRequest(instanceId: string, payload: any) {
    state.forwarded.push({ instanceId, payload })
    if (state.replyMs !== null) await sleep(state.replyMs)
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"plans":[]}' }
  },
  sendTunnelStreamRequest(instanceId: string, payload: any, onChunk: (chunk: any) => void) {
    state.streamed.push({ instanceId, payload })
    onChunk({ type: 'stream-chunk', requestId: 'req-1', data: 'data: {"type":"text-delta"}\n\n' })
    onChunk({ type: 'stream-end', requestId: 'req-1' })
    return { cancel() {} }
  },
  generateRequestId: () => 'req-1',
}

function app() {
  const a = new Hono()
  a.all('/api/internal/host-tunnel/*', (c) =>
    handleHostTunnel(c, {
      _peerAddress: '127.0.0.1',
      _hostOf: async () => 'inst-1',
      _tunnel: tunnel,
    }),
  )
  return a
}

beforeEach(() => {
  _resetHostCacheForTests()
  state.instance = { id: 'inst-1', name: 'Studio Mac', userId: 'user-1' }
  state.project = { id: 'proj-1', workspaceId: 'ws-1' }
  state.wakeCalls = []
  state.wakeState = 'connected'
  state.wakeMs = 0
  state.wakeOverrun = false
  state.forwarded = []
  state.streamed = []
  state.replyMs = null
})

describe('handleHostTunnel — the wake is capped at the interactive window', () => {
  test('a host that misses the wake window answers host_connecting inside it, with Retry-After', async () => {
    state.wakeState = 'connecting'
    // The real wake uses its whole budget before it gives up — an idle desktop
    // polling 60 s from now. On main that is up to 75 s inside the request.
    state.wakeMs = 10_000

    const started = Date.now()
    const res = await app().request(tunnelPath(PLANS), { method: 'GET' })
    const elapsed = Date.now() - started

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('host_connecting')
    expect(body.error.retryable).toBe(true)
    expect(body.error.retryAfterSeconds).toBe(15)
    expect(res.headers.get('retry-after')).toBe('15')

    // Bounded by the interactive window, and well inside the edge budget.
    expect(state.wakeCalls[0].opts?.maxWaitMs).toBe(WAKE_WINDOW_MS)
    expect(elapsed).toBeGreaterThanOrEqual(WAKE_WINDOW_MS - 50)
    expect(elapsed).toBeLessThan(EDGE_BUDGET_MS)
    expect(state.forwarded).toHaveLength(0)
  })

  test('a host that is really away is still host_offline, with no retry hint', async () => {
    state.wakeState = 'offline'
    const res = await app().request(tunnelPath(PLANS), { method: 'GET' })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('host_offline')
    expect(res.headers.get('retry-after')).toBeNull()
  })

  test('a connected host is forwarded exactly as before', async () => {
    const res = await app().request(tunnelPath(PLANS), { method: 'GET' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ plans: [] })
    expect(state.forwarded).toHaveLength(1)
  })
})

describe('handleHostTunnel — one edge budget for the whole call', () => {
  test('a tunnel reply that outlasts the budget answers 504 host_runtime_starting, not a hang', async () => {
    // Everything the budget allows on top of a wake that already answered.
    state.wakeMs = 100
    state.replyMs = 5_000

    const started = Date.now()
    const res = await app().request(tunnelPath(PLANS), { method: 'GET' })
    const elapsed = Date.now() - started

    expect(res.status).toBe(504)
    const body = await res.json()
    expect(body.error.code).toBe('host_runtime_starting')
    expect(body.error.retryable).toBe(true)
    expect(body.error.retryAfterSeconds).toBe(15)
    expect(res.headers.get('retry-after')).toBe('15')
    expect(elapsed).toBeLessThan(EDGE_BUDGET_MS + 100)
  })

  test('a wake that eats the whole budget answers 504 rather than forwarding', async () => {
    state.wakeState = 'connected'
    state.wakeMs = EDGE_BUDGET_MS + 50
    state.wakeOverrun = true

    const started = Date.now()
    const res = await app().request(tunnelPath(PLANS), { method: 'GET' })
    const elapsed = Date.now() - started

    expect(res.status).toBe(504)
    expect((await res.json()).error.code).toBe('host_runtime_starting')
    expect(state.forwarded).toHaveLength(0)
    // The wake still honours its own cap, so this is the wake window, not 90 s.
    expect(elapsed).toBeLessThan(EDGE_BUDGET_MS + 100)
  })
})

describe('handleHostTunnel — a stream sends its headers before the wake', () => {
  test('a sleeping host resumes as an event stream that reports the wake failure', async () => {
    state.wakeState = 'connecting'
    state.wakeMs = 200

    const started = Date.now()
    const res = await app().request(tunnelPath(RESUME), {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    })
    const elapsed = Date.now() - started

    // Headers are out before the wake has finished, so nothing sits header-less
    // past the edge budget.
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(elapsed).toBeLessThan(state.wakeMs)

    const body = await res.text()
    expect(body).toContain('data: {"type":"error"')
    expect(body).toContain('host_connecting')
    expect(state.streamed).toHaveLength(0)
  })

  test('a connected host streams its chunks through', async () => {
    const res = await app().request(tunnelPath(RESUME), {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('text-delta')
    expect(state.streamed).toHaveLength(1)
    expect(state.wakeCalls[0].opts?.maxWaitMs).toBe(WAKE_WINDOW_MS)
  })
})
