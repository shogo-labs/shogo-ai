// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A live agent turn is never cut by the clock (SHO-546).
 *
 * The desktop tunnel used to kill every stream at `STREAM_MAX_TIMEOUT_MS` (10
 * min) however busy it was, and the cross-pod relay did the same at
 * `STREAM_RELAY_TIMEOUT_MS`. A turn that runs longer than that finished on the
 * desktop with no row in the cloud.
 *
 * The windows are read per request (`SHOGO_TUNNEL_STREAM_*`,
 * `SHOGO_TUNNEL_STREAM_RELAY_*`), so this file shrinks them to tens of
 * milliseconds and proves both halves of the contract:
 *
 *   - an agent stream that keeps sending chunks outlives its wall-clock window,
 *   - one that goes silent still dies,
 *   - a non-agent stream keeps the wall-clock cap it always had.
 *
 * Run: bun test apps/api/src/__tests__/tunnel-agent-stream-timeouts.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// Local mode keeps tunnel-redis off a real Redis: these streams run in-process.
process.env.SHOGO_LOCAL_MODE = 'true'

const INSTANCE_ID = 'inst-sho546'

const mockInstance = {
  id: INSTANCE_ID,
  workspaceId: 'ws-1',
  name: 'sho546',
  hostname: 'sho546',
  os: 'darwin',
  arch: 'arm64',
  status: 'online',
  lastSeenAt: new Date(),
  wsRequestedAt: null as Date | null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const mockPrisma = {
  instance: {
    upsert: async () => ({ ...mockInstance }),
    findUnique: async () => ({ ...mockInstance }),
    findMany: async () => [{ ...mockInstance }],
    update: async () => ({ ...mockInstance }),
    delete: async () => ({ ...mockInstance }),
  },
  member: { findFirst: async () => ({ id: 'm-1', userId: 'user-1', workspaceId: 'ws-1' }) },
  user: { findUnique: async () => ({ role: 'user' }) },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({ resolveApiKey: async () => null }))
mock.module('../routes/remote-audit', () => ({
  logRemoteAction: async () => undefined,
  classifyAction: () => 'test_action',
}))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => undefined,
  sendPushToUser: async () => undefined,
}))

const { _testing } = await import('../routes/instances')
const { isAgentStreamTunnelPath } = await import('../lib/agent-stream-paths')

const MAX_MS = 80
const IDLE_MS = 60

process.env.SHOGO_TUNNEL_STREAM_MAX_TIMEOUT_MS = String(MAX_MS)
process.env.SHOGO_TUNNEL_STREAM_IDLE_TIMEOUT_MS = String(IDLE_MS)
process.env.SHOGO_TUNNEL_STREAM_FIRST_CHUNK_TIMEOUT_MS = String(MAX_MS)

type Chunk = { type: string; data?: string; error?: string }

/** A tunnel connection whose `send` hands every outgoing frame to `onSend`. */
function setupTunnel(onSend: (msg: any) => void): void {
  const ws: any = {
    send: (raw: string) => onSend(JSON.parse(raw)),
    data: { instanceId: INSTANCE_ID, workspaceId: 'ws-1', _lastPong: Date.now() },
    readyState: 1,
  }
  _testing.tunnels.set(INSTANCE_ID, {
    ws,
    instanceId: INSTANCE_ID,
    workspaceId: 'ws-1',
    pendingRequests: new Map(),
    streamHandlers: new Map(),
  })
}

function pushChunk(requestId: string, data: string): void {
  const handler = _testing.tunnels.get(INSTANCE_ID)?.streamHandlers.get(requestId)
  handler?.({ type: 'stream-chunk', requestId, data })
}

function endStream(requestId: string): void {
  const handler = _testing.tunnels.get(INSTANCE_ID)?.streamHandlers.get(requestId)
  handler?.({ type: 'stream-end', requestId })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('agent stream paths are unwrapped for stream decisions', () => {
  test('a tunneled resume path is recognised through its agent-proxy wrapper', () => {
    expect(isAgentStreamTunnelPath('GET', '/api/workspaces/ws-1/agent-proxy/agent/chat/s-1/stream?fromSeq=0')).toBe(true)
    expect(isAgentStreamTunnelPath('POST', '/api/projects/p-1/agent-proxy/agent/chat')).toBe(true)
    expect(isAgentStreamTunnelPath('GET', '/api/workspaces/ws-1/agent-proxy/agent/chat/s-1/stream')).toBe(true)
  })

  test('a path that is not an agent turn is not one', () => {
    expect(isAgentStreamTunnelPath('GET', '/api/workspaces/ws-1/agent-proxy/api/projects')).toBe(false)
    expect(isAgentStreamTunnelPath('GET', '/api/workspaces/ws-1/agent-proxy/agent/files/list')).toBe(false)
    expect(isAgentStreamTunnelPath('DELETE', '/api/workspaces/ws-1/agent-proxy/agent/chat')).toBe(false)
  })
})

describe('local tunnel stream — agent turns', () => {
  beforeEach(() => _testing.tunnels.clear())
  afterEach(() => _testing.tunnels.clear())

  test('a stream that keeps sending chunks outlives the wall-clock max', async () => {
    setupTunnel(() => {})
    const chunks: Chunk[] = []
    // Four times the wall-clock window, with a chunk every 20 ms: exactly the
    // shape a live turn has (the runtime heartbeats every 250 ms).
    _testing.sendLocalTunnelStreamRequest(
      INSTANCE_ID,
      { type: 'request', requestId: 'req-live', method: 'GET', path: '/agent/chat/s-1/stream?fromSeq=0' },
      (chunk: Chunk) => chunks.push(chunk),
    )
    const started = Date.now()
    for (let i = 0; i < 16; i++) {
      await sleep(20)
      pushChunk('req-live', `data: {"type":"data-turn-seq","data":{"seq":${i}}}\n\n`)
    }
    endStream('req-live')
    const elapsed = Date.now() - started

    expect(elapsed).toBeGreaterThan(MAX_MS * 3)
    expect(chunks.filter((c) => c.type === 'stream-chunk')).toHaveLength(16)
    expect(chunks.some((c) => c.type === 'stream-error')).toBe(false)
    expect(chunks.some((c) => c.type === 'stream-end')).toBe(true)
  })

  test('a stream that goes silent still dies on the idle timeout', async () => {
    setupTunnel(() => {})
    const chunks: Chunk[] = []
    _testing.sendLocalTunnelStreamRequest(
      INSTANCE_ID,
      { type: 'request', requestId: 'req-silent', method: 'GET', path: '/agent/chat/s-1/stream?fromSeq=0' },
      (chunk: Chunk) => chunks.push(chunk),
    )
    pushChunk('req-silent', 'data: {"type":"text-delta","delta":"hi"}\n\n')
    await sleep(IDLE_MS + 80)

    const error = chunks.find((c) => c.type === 'stream-error')
    expect(error?.error).toContain('idle')
  })
})

describe('local tunnel stream — non-agent streams keep the wall clock', () => {
  beforeEach(() => _testing.tunnels.clear())
  afterEach(() => _testing.tunnels.clear())

  test('a non-agent stream is still capped even while it sends chunks', async () => {
    setupTunnel(() => {})
    const chunks: Chunk[] = []
    _testing.sendLocalTunnelStreamRequest(
      INSTANCE_ID,
      { type: 'request', requestId: 'req-canvas', method: 'GET', path: '/not-an-agent-stream' },
      (chunk: Chunk) => chunks.push(chunk),
    )
    const started = Date.now()
    while (Date.now() - started < MAX_MS * 4) {
      await sleep(15)
      pushChunk('req-canvas', 'data: {"type":"frame"}\n\n')
    }

    const error = chunks.find((c) => c.type === 'stream-error')
    expect(error?.error).toContain('max')
  })
})

describe('tunnelStreamResponse', () => {
  beforeEach(() => _testing.tunnels.clear())
  afterEach(() => _testing.tunnels.clear())

  test('turns tunnel chunks into a readable Response body', async () => {
    let requestId: string | null = null
    setupTunnel((msg) => {
      if (msg.stream) requestId = msg.requestId
    })
    const response = _testing.tunnelStreamResponse(INSTANCE_ID, {
      type: 'request',
      requestId: 'req-response',
      method: 'GET',
      path: '/agent/chat/s-1/stream?fromSeq=0',
    })
    expect(response.status).toBe(200)
    expect(requestId).toBe('req-response')

    pushChunk('req-response', 'data: {"type":"text-delta","delta":"full turn"}\n\n')
    endStream('req-response')
    const body = await response.text()
    expect(body).toContain('full turn')
  })
})
