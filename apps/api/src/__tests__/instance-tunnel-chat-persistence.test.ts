// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tunneled chat — assistant message persistence contract.
 *
 * When a user picks a paired Instance from the Studio environment
 * picker (a `desktop` Electron app or `cli-worker` running `shogo
 * worker`), Studio routes the chat POST through the cloud transparent
 * proxy at
 *
 *   POST /api/instances/:instanceId/p/api/projects/:projectId/agent-proxy/agent/chat
 *
 * Regression history: this path used to skip persistence entirely,
 * because the transparent proxy bracketed the relay with the
 * billing-only `trackChatStreamForBilling`. The runtime on the
 * tunneled machine would stream a full assistant turn, the bytes
 * reached the client, the user saw the reply on screen — and on page
 * reload it was gone because nothing on the cloud wrote the assistant
 * `ChatMessage` row.
 *
 * Required behavior:
 *   - The full SSE turn still reaches the client unchanged.
 *   - The billing session is still opened/closed against the
 *     chat-session header (so AI proxy tokens route to the right
 *     `(projectId, chatSessionId)` bucket).
 *   - The assistant `ChatMessage` row is persisted on the cloud DB,
 *     keyed on the same chat-session id, with `role = 'assistant'`
 *     and content matching the accumulated `text-delta` payload —
 *     exactly the same shape `trackUsageFromStream` writes when the
 *     turn flows through `/api/projects/:id/chat` directly.
 *
 *   bun test apps/api/src/__tests__/instance-tunnel-chat-persistence.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'

// ─── Mocks ──────────────────────────────────────────────────────────────────

const INSTANCE_ID = 'inst-tunnel-persistence'
const PROJECT_ID = 'proj-tunneled'
const CHAT_SESSION_ID = 'session-tunneled'

const mockInstance = {
  id: INSTANCE_ID,
  workspaceId: 'ws-1',
  name: 'tunneled-worker',
  hostname: 'tunneled-worker',
  os: 'darwin',
  arch: 'arm64',
  status: 'online',
  lastSeenAt: new Date(),
  wsRequestedAt: null as Date | null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const chatMessageCreate = mock(async (args: any) => ({ id: 'msg-x', ...args.data }))
const chatSessionFindUnique = mock(async () => ({ id: CHAT_SESSION_ID }))
const projectFindUnique = mock(async () => ({
  id: PROJECT_ID,
  name: 'Tunneled',
  workspaceId: 'ws-1',
}))

const mockPrisma = {
  instance: {
    upsert: mock(() => Promise.resolve({ ...mockInstance })),
    findUnique: mock(() => Promise.resolve({ ...mockInstance })),
    findMany: mock(() => Promise.resolve([{ ...mockInstance }])),
    update: mock(() => Promise.resolve({ ...mockInstance })),
    delete: mock(() => Promise.resolve({ ...mockInstance })),
  },
  member: {
    findFirst: mock(() =>
      Promise.resolve({ id: 'm-1', userId: 'user-1', workspaceId: 'ws-1' }),
    ),
  },
  chatMessage: { create: chatMessageCreate },
  chatSession: { findUnique: chatSessionFindUnique },
  project: { findUnique: projectFindUnique, update: mock(async () => ({})) },
  toolCallLog: { createMany: mock(async () => ({ count: 0 })) },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(async () => null),
}))
mock.module('../routes/remote-audit', () => ({
  logRemoteAction: mock(() => Promise.resolve()),
  classifyAction: mock(() => 'test_action'),
}))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: mock(() => Promise.resolve()),
}))

// Real `closeSession` calls `consumeUsage` to charge the workspace at
// the end of the turn; in tests we don't want to hit Stripe / require
// a billing.service module that touches the network.
mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => true,
}))

// NOTE: we deliberately do NOT mock `../lib/proxy-billing-session`.
// `mock.module` is process-global in bun, and the existing
// `instances-ws-handlers.test.ts` mocks the same module with bare
// stubs — running ours on top with even bare-r stubs would just
// pile on the leak. Instead we let the real billing module run
// in-memory (it's a Map plus a no-op `consumeUsage` mock from the
// billing-service stub below) so this file's only externally
// observable side effect is a chatMessage row write.

const testUser = { id: 'user-1', userId: 'user-1', email: 'test@test.com', role: 'super_admin' }

// Imports come AFTER `mock.module` so the routes pick up our fakes.
const { instanceRoutes, _testing, handleInstanceWsMessage } = await import('../routes/instances')

function createTestApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', testUser)
    await next()
  })
  app.route('/api', instanceRoutes())
  return app
}

// ─── Tunnel helpers (mirrors apps/api/src/__tests__/instances-streaming.test.ts)

function setupMockTunnel(
  instanceId: string,
  onSend: (msg: any, mockWs: any) => void,
) {
  const mockWs: any = {
    send: mock((data: string) => {
      const msg = JSON.parse(data)
      onSend(msg, mockWs)
    }),
    data: { instanceId, workspaceId: 'ws-1', _lastPong: Date.now() },
    readyState: 1,
  }

  _testing.tunnels.set(instanceId, {
    ws: mockWs,
    instanceId,
    workspaceId: 'ws-1',
    pendingRequests: new Map(),
    streamHandlers: new Map(),
  })

  return mockWs
}

function emitStreamChunks(
  mockWs: any,
  requestId: string,
  chunks: string[],
  intervalMs = 1,
): Promise<void> {
  return new Promise((resolve) => {
    let i = 0
    const next = () => {
      if (i < chunks.length) {
        handleInstanceWsMessage(mockWs, JSON.stringify({
          type: 'stream-chunk',
          requestId,
          data: chunks[i],
        }))
        i++
        setTimeout(next, intervalMs)
      } else {
        handleInstanceWsMessage(mockWs, JSON.stringify({
          type: 'stream-end',
          requestId,
        }))
        resolve()
      }
    }
    setTimeout(next, 1)
  })
}

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let acc = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    acc += decoder.decode(value, { stream: true })
  }
  return acc
}

// Minimal full SSE turn — text-delta + terminal frame. Identical shape
// to what the runtime emits over a healthy chat connection.
const ASSISTANT_SSE_CHUNKS = [
  'data: {"type":"text-delta","delta":"hello from tunneled "}\n',
  'data: {"type":"text-delta","delta":"machine"}\n',
  'data: {"type":"data-turn-complete","data":{"status":"completed"}}\n',
]

beforeEach(() => {
  chatMessageCreate.mockClear()
  chatSessionFindUnique.mockClear()
})
afterEach(() => {
  _testing.tunnels.clear()
})

// ─── REGRESSION: tunneled chat does not persist assistant rows ──────────────

describe('Tunneled chat through /api/instances/:id/p/.../agent-proxy/agent/chat', () => {
  test('streams a full assistant turn back to the client', async () => {
    setupMockTunnel(INSTANCE_ID, (msg, ws) => {
      if (msg.stream) emitStreamChunks(ws, msg.requestId, ASSISTANT_SSE_CHUNKS)
    })

    const app = createTestApp()
    const res = await app.request(
      `/api/instances/${INSTANCE_ID}/p/api/projects/${PROJECT_ID}/agent-proxy/agent/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Chat-Session-Id': CHAT_SESSION_ID,
        },
        body: JSON.stringify({
          chatSessionId: CHAT_SESSION_ID,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')

    const body = await drain(res)
    // Sanity: the assistant text reached the client. The SDK splits
    // the turn into multiple text-delta frames, so we check each
    // delta lands rather than the joined sentence.
    expect(body).toContain('hello from tunneled ')
    expect(body).toContain('machine')
    expect(body).toContain('data-turn-complete')
  })

  test('persists an assistant ChatMessage row keyed on the chat-session header', async () => {
    setupMockTunnel(INSTANCE_ID, (msg, ws) => {
      if (msg.stream) emitStreamChunks(ws, msg.requestId, ASSISTANT_SSE_CHUNKS)
    })

    const app = createTestApp()
    const res = await app.request(
      `/api/instances/${INSTANCE_ID}/p/api/projects/${PROJECT_ID}/agent-proxy/agent/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Chat-Session-Id': CHAT_SESSION_ID,
        },
        body: JSON.stringify({
          chatSessionId: CHAT_SESSION_ID,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    )
    expect(res.status).toBe(200)

    // Drain — `trackUsageFromStream` only persists after it has
    // consumed the SSE and observed `data-turn-complete`.
    await drain(res)
    // Background tee runs fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 100))

    expect(chatMessageCreate).toHaveBeenCalled()
    const lastCall = chatMessageCreate.mock.calls[chatMessageCreate.mock.calls.length - 1]
    const args = lastCall[0]
    expect(args.data.sessionId).toBe(CHAT_SESSION_ID)
    expect(args.data.role).toBe('assistant')
    expect(args.data.content).toBe('hello from tunneled machine')
  })

  // NOTE: the open/close billing-session contract on this path is
  // already covered by `instances-streaming.test.ts` and
  // `chat-usage-tracker.test.ts`. We don't re-assert it here to avoid
  // duplicating the mock surface of the real `proxy-billing-session`
  // module (and the cross-file mock-leak that produces).

  test('no chat-session header → no persistence (legacy / probe traffic stays a passthrough)', async () => {
    // A bare `/agent/chat` POST with no X-Chat-Session-Id header (e.g.
    // the SDK examples / standalone CLI use cases) must NOT silently
    // persist into a random session. Persistence requires the header.
    setupMockTunnel(INSTANCE_ID, (msg, ws) => {
      if (msg.stream) emitStreamChunks(ws, msg.requestId, ASSISTANT_SSE_CHUNKS)
    })

    const app = createTestApp()
    const res = await app.request(
      `/api/instances/${INSTANCE_ID}/p/api/projects/${PROJECT_ID}/agent-proxy/agent/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    )
    expect(res.status).toBe(200)
    await drain(res)
    await new Promise((r) => setTimeout(r, 100))

    expect(chatMessageCreate).not.toHaveBeenCalled()
  })

  test('partial turn (no data-turn-complete) still persists the accumulated assistant text', async () => {
    // Mirrors `trackUsageFromStream`'s partial-persist behavior on the
    // cloud-direct path: if the stream is cut before the terminal
    // frame, the row is still written with whatever text arrived so
    // the user sees their truncated answer on reload rather than
    // a one-way mirror.
    setupMockTunnel(INSTANCE_ID, (msg, ws) => {
      if (msg.stream) {
        emitStreamChunks(ws, msg.requestId, [
          'data: {"type":"text-delta","delta":"partial answer"}\n',
        ])
      }
    })

    const app = createTestApp()
    const res = await app.request(
      `/api/instances/${INSTANCE_ID}/p/api/projects/${PROJECT_ID}/agent-proxy/agent/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Chat-Session-Id': CHAT_SESSION_ID,
        },
        body: JSON.stringify({
          chatSessionId: CHAT_SESSION_ID,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    )
    expect(res.status).toBe(200)
    await drain(res)
    await new Promise((r) => setTimeout(r, 100))

    expect(chatMessageCreate).toHaveBeenCalled()
    const args = chatMessageCreate.mock.calls[chatMessageCreate.mock.calls.length - 1][0]
    expect(args.data.sessionId).toBe(CHAT_SESSION_ID)
    expect(args.data.role).toBe('assistant')
    expect(args.data.content).toBe('partial answer')
  })
})
