// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Integration test: a real @a2a-js/sdk/client, over real HTTP (Bun.serve),
// against the actual a2aProtocolRoutes() router — card discovery + JSON-RPC
// message/stream — with only the "outside world" mocked: prisma, the
// project's runtime pod (a stub replaying a recorded SSE transcript), pod
// resolution, and billing persistence.
//
// This is the "drive @a2a-js/sdk/client against a stub pod" test called for
// by the A2A implementation plan.

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { TaskState, type SendMessageRequest, type StreamResponse } from '@a2a-js/sdk'
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client'

const PROJECT_ID = 'proj-integration-1'
const FAKE_POD_URL = 'http://fake-pod.internal'

// ---------------------------------------------------------------------------
// Mocks — everything a2a.ts touches outside the process boundary.
// ---------------------------------------------------------------------------

// routes/a2a.ts pulls in middleware/auth.ts (for the key-CRUD router), which
// pulls in ../auth (real Better Auth setup) and ../routes/api-keys. Neither
// is exercised by this test (only a2aProtocolRoutes is mounted), but both
// must be safe to *import* — mock them the same way middleware/auth.test.ts
// does to avoid constructing a real Better Auth instance.
mock.module('../../auth', () => ({ auth: { api: { getSession: async () => null } } }))
mock.module('../api-keys', () => ({ resolveApiKey: async () => null }))
mock.module('../../lib/runtime-token', () => ({ verifyRuntimeToken: () => ({ ok: false }) }))

interface FakeApiKeyRow {
  id: string
  keyId: string
  hashedSecret: string
  projectId: string
  workspaceId: string
  revokedAt: Date | null
  expiresAt: Date | null
  lastUsedAt: Date | null
}
interface FakeTaskRow {
  id: string
  contextId: string
  projectId: string
  state: string
  taskJson: string
  chatSessionId: string | null
  createdAt: Date
  updatedAt: Date
}

const apiKeyRows: FakeApiKeyRow[] = []
const taskRows: FakeTaskRow[] = []
let taskClock = 0

mock.module('../../lib/prisma', () => ({
  prisma: {
    a2aApiKey: {
      create: async ({ data }: any) => {
        const row: FakeApiKeyRow = { ...data, revokedAt: null, lastUsedAt: null, expiresAt: data.expiresAt ?? null }
        apiKeyRows.push(row)
        return row
      },
      findUnique: async ({ where }: any) => apiKeyRows.find((r) => r.keyId === where.keyId) ?? null,
      update: async ({ where, data }: any) => {
        const row = apiKeyRows.find((r) => r.id === where.id)
        if (row) Object.assign(row, data)
        return row
      },
    },
    a2aTask: {
      upsert: async ({ where, create, update }: any) => {
        taskClock += 1
        const existing = taskRows.find((r) => r.id === where.id)
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date(taskClock) })
          return existing
        }
        const row: FakeTaskRow = { ...create, chatSessionId: create.chatSessionId ?? null, createdAt: new Date(taskClock), updatedAt: new Date(taskClock) }
        taskRows.push(row)
        return row
      },
      findUnique: async ({ where }: any) => taskRows.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }: any) => taskRows.filter((r) => r.projectId === where.projectId),
      count: async ({ where }: any) => taskRows.filter((r) => r.projectId === where.projectId).length,
    },
    project: {
      findUnique: async ({ where }: any) =>
        where.id === PROJECT_ID ? { name: 'Integration Project', description: 'A stub project for A2A tests' } : null,
    },
    chatSession: {
      findUnique: async () => null,
      create: async () => ({}),
    },
  },
}))

mock.module('../../services/projectAgent.service', () => ({
  resolveProjectAgent: async () => null,
}))

mock.module('../../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async () => ({ url: FAKE_POD_URL }),
}))

mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'fake-runtime-token',
}))

mock.module('../project-chat', () => ({
  trackUsageFromStream: async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
  },
}))

// The recorded SSE transcript the stub pod replays for /agent/chat.
const POD_TRANSCRIPT = [
  { type: 'text-delta', delta: 'Hello ' },
  { type: 'text-delta', delta: 'from the agent' },
  { type: 'data-turn-complete', data: { status: 'completed' } },
]

function sseStream(chunks: any[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[i++])}\n\n`))
    },
  })
}

/** Overridable per-test so the concurrent-tasks test can hold the "pod"
 * response open until it has confirmed the second request was rejected. */
let podChatResponder: () => Promise<Response> = async () => new Response(sseStream(POD_TRANSCRIPT), { status: 200 })

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input))
  if (url.startsWith(FAKE_POD_URL)) {
    if (url.endsWith('/agent/chat')) {
      return podChatResponder()
    }
    throw new Error(`stub pod: unexpected request ${url}`)
  }
  return originalFetch(input, init)
}) as any

const { a2aProtocolRoutes } = await import('../a2a')
const { mintA2aApiKey } = await import('../../lib/a2a/auth')
const { Hono } = await import('hono')

// ---------------------------------------------------------------------------
// Test server + client setup
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>
let baseUrl: string
let bearerToken: string

function authedFetch(token: string): typeof fetch {
  return (async (input: any, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    return fetch(input, { ...init, headers })
  }) as typeof fetch
}

beforeAll(async () => {
  const app = new Hono()
  app.route('/a2a', a2aProtocolRoutes())
  server = Bun.serve({ port: 0, fetch: app.fetch })
  baseUrl = `http://localhost:${server.port}`
  // buildAgentCard() (called per-request, see routes/a2a.ts) reads this at
  // call time to compute the RPC URL it advertises in the card.
  process.env.SHOGO_A2A_BASE_URL = baseUrl

  const minted = await mintA2aApiKey({ projectId: PROJECT_ID, workspaceId: 'ws-1', createdBy: 'tester' })
  bearerToken = minted.fullKey
})

afterAll(() => {
  server.stop(true)
  globalThis.fetch = originalFetch
})

async function makeClient() {
  const fetchImpl = authedFetch(bearerToken)
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  })
  // `createFromUrl`'s default card path (AGENT_CARD_PATH) is site-root-
  // relative (`/.well-known/agent-card.json`), which `new URL(path, base)`
  // resolves against the origin only — it would silently drop our
  // project-scoped prefix. Pass the full project-scoped card path instead.
  return factory.createFromUrl(baseUrl, `/a2a/projects/${PROJECT_ID}/.well-known/agent-card.json`)
}

function sendRequest(text: string): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId: crypto.randomUUID(),
      contextId: '',
      taskId: '',
      role: 1, // ROLE_USER
      parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  } as SendMessageRequest
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /a2a/projects/:projectId/.well-known/agent-card.json', () => {
  it('requires a bearer token', async () => {
    const res = await fetch(`${baseUrl}/a2a/projects/${PROJECT_ID}/.well-known/agent-card.json`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('rejects a key minted for a different project', async () => {
    const other = await mintA2aApiKey({ projectId: 'some-other-project', workspaceId: 'ws-2', createdBy: 'tester' })
    const res = await fetch(`${baseUrl}/a2a/projects/${PROJECT_ID}/.well-known/agent-card.json`, {
      headers: { authorization: `Bearer ${other.fullKey}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns 404 for a project the store does not know about', async () => {
    const missingKey = await mintA2aApiKey({ projectId: 'ghost-project', workspaceId: 'ws-3', createdBy: 'tester' })
    const res = await fetch(`${baseUrl}/a2a/projects/ghost-project/.well-known/agent-card.json`, {
      headers: { authorization: `Bearer ${missingKey.fullKey}` },
    })
    expect(res.status).toBe(404)
  })

  it('returns a v1.0 agent card advertising streaming and the project tenant', async () => {
    const res = await fetch(`${baseUrl}/a2a/projects/${PROJECT_ID}/.well-known/agent-card.json`, {
      headers: { authorization: `Bearer ${bearerToken}` },
    })
    expect(res.status).toBe(200)
    const card = await res.json()
    expect(card.name).toBe('Integration Project')
    expect(card.capabilities.streaming).toBe(true)
    expect(card.supportedInterfaces[0]).toMatchObject({
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
      tenant: PROJECT_ID,
      url: `${baseUrl}/a2a/projects/${PROJECT_ID}/rpc`,
    })
  })
})

describe('POST /a2a/projects/:projectId/rpc — message/send', () => {
  it('rejects requests without a valid bearer token', async () => {
    const res = await fetch(`${baseUrl}/a2a/projects/${PROJECT_ID}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: sendRequest('hi') }),
    })
    expect(res.status).toBe(401)
  })

  it('drives a client.sendMessage() call end to end against the stub pod and returns a COMPLETED task', async () => {
    const client = await makeClient()
    const result = await client.sendMessage(sendRequest('Say hello'))
    expect('status' in result).toBe(true)
    if ('status' in result) {
      expect(result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
      expect(result.artifacts?.[0]?.parts?.map((p: any) => p.content?.value).join('')).toBe('Hello from the agent')
    }
  })
})

describe('POST /a2a/projects/:projectId/rpc — message/stream', () => {
  it('streams task -> artifactUpdate -> terminal COMPLETED statusUpdate events via SSE', async () => {
    const client = await makeClient()
    const received: StreamResponse['payload'][] = []
    for await (const event of client.sendMessageStream(sendRequest('Say hello, streaming'))) {
      received.push(event.payload)
    }

    expect(received[0]?.$case).toBe('task')
    expect(received.some((p) => p?.$case === 'artifactUpdate')).toBe(true)

    const last = received[received.length - 1]
    expect(last?.$case).toBe('statusUpdate')
    if (last?.$case === 'statusUpdate') {
      expect(last.value.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    }

    const text = received
      .filter((p) => p?.$case === 'artifactUpdate')
      .flatMap((p) => (p!.value as any).artifact.parts)
      .map((part: any) => part.content?.value)
      .join('')
    expect(text).toBe('Hello from the agent')
  })

  it('rejects a second concurrent sendMessageStream on the same contextId', async () => {
    // Hold the "pod" response open so the first turn stays in-flight long
    // enough for the second request's ShogoAgentExecutor.execute() guard
    // to observe it and reject — against the real stub this resolves
    // near-instantly, which would let req2 land after req1 already settled.
    let releasePod: ((res: Response) => void) | undefined
    podChatResponder = () =>
      new Promise<Response>((resolve) => {
        releasePod = resolve
      })

    const client = await makeClient()
    const contextId = `shared-${crypto.randomUUID()}`
    const req1 = sendRequest('first')
    req1.message!.contextId = contextId
    const req2 = sendRequest('second')
    req2.message!.contextId = contextId

    const drain = async (req: SendMessageRequest) => {
      const events: StreamResponse['payload'][] = []
      for await (const e of client.sendMessageStream(req)) events.push(e.payload)
      return events
    }

    const p1 = drain(req1)
    // Wait until req1's chain has actually reached the pod fetch (i.e. is
    // registered as in-flight) before firing req2.
    while (!releasePod) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const events2 = await drain(req2)

    const last2 = events2[events2.length - 1]
    expect(last2?.$case).toBe('statusUpdate')
    if (last2?.$case === 'statusUpdate') {
      expect(last2.value.status?.state).toBe(TaskState.TASK_STATE_FAILED)
    }

    // Now let req1 complete normally and restore the default responder.
    releasePod!(new Response(sseStream(POD_TRANSCRIPT), { status: 200 }))
    await p1
    podChatResponder = async () => new Response(sseStream(POD_TRANSCRIPT), { status: 200 })
  })
})
