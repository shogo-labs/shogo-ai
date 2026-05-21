// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project-chat router — proxy / admin endpoint coverage.
 *
 * Complements `chat-eof-resume.test.ts` (trackUsageFromStream) and
 * `chat-turn-route.test.ts` (the public /api/chat/turn entry) by
 * exercising the per-project proxy endpoints that forward to a
 * Runtime pod via `fetchFromRuntime`:
 *
 *   - GET  /projects/:projectId/chat/:chatSessionId/stream
 *   - GET  /projects/:projectId/chat/:chatSessionId/turn
 *   - POST /projects/:projectId/chat/stop
 *   - POST /projects/:projectId/chat/subagents/:instanceId/stop
 *   - POST /projects/:projectId/permission-response
 *   - GET  /projects/:projectId/chat/status
 *   - POST /projects/:projectId/chat/wake
 *
 *   bun test apps/api/src/__tests__/project-chat-route.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'

// @shogo/model-catalog re-exports from @shogo-ai/sdk/model-catalog which has no
// built dist on this branch — stub before the dynamic import chain loads it.
mock.module('@shogo/model-catalog', () => ({
  getModelTier: (_modelId: string) => 'standard',
  resolveModelId: (mode: string) => mode || 'claude-haiku-4-5',
  MODEL_CATALOG: {},
  getModelEntry: (_id: string) => null,
  MODEL_DOLLAR_COSTS: {} as Record<string, any>,
  calculateDollarCost: () => 0,
  getModelBillingModel: (id: string) => id,
  resolveAgentModeDefault: (mode: string) => mode,
}))

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET ?? 'test-secret'
delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.SHOGO_VM_ISOLATION

let projectFixture: { id: string; name: string; workspaceId: string } | null = {
  id: 'p-1', name: 'Test', workspaceId: 'w-1',
}
let memberFixture: { id: string } | null = { id: 'member-1' }

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async (args: any) => {
        if (args?.where?.id === 'p-missing') return null
        return projectFixture
      },
      update: async () => ({}),
    },
    chatMessage: { create: async (args: any) => ({ id: 'm-1', ...args.data }) },
    chatSession: { findUnique: async () => ({ id: 's-1' }) },
    toolCallLog: { createMany: async () => ({ count: 0 }) },
    member: { findFirst: async () => memberFixture },
  },
}))

let hasBalanceResult = true
let hasAdvancedModelAccessResult = true
mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
  hasBalance: async () => hasBalanceResult,
  hasAdvancedModelAccess: async () => hasAdvancedModelAccessResult,
}))

mock.module('../services/git.service', () => ({
  isGitAvailable: () => false,
}))

mock.module('../services/checkpoint.service', () => ({
  createAutoCheckpoint: async () => ({ id: 'ck-1' }),
  createCheckpoint: async () => ({ id: 'ck-1' }),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => 'sess-1',
  closeSession: async () => ({ done: true }),
  setQualitySignals: () => false,
  hasSession: () => false,
  accumulateUsage: () => {},
}))

let resolvePodUrlResult: { url: string } | Error = { url: 'http://runtime-p-1.local' }
mock.module('../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async () => {
    if (resolvePodUrlResult instanceof Error) throw resolvePodUrlResult
    return resolvePodUrlResult
  },
}))

mock.module('../lib/runtime-token', () => ({
  deriveRuntimeToken: () => 'tok-1',
}))

mock.module('../lib/project-user-context', () => ({
  setProjectUser: (projectId: string, userId: string) => { setProjectUserCalls.push({ projectId, userId }) },
  getProjectUser: () => null,
}))

// Stub fetch — used by fetchFromRuntime.
let nextFetchResponse: () => Response = () =>
  new Response(JSON.stringify({ status: 'running' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
let lastFetchUrl: string | null = null
let lastFetchInit: RequestInit | undefined
const setProjectUserCalls: Array<{ projectId: string; userId: string }> = []
const originalFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    lastFetchUrl = typeof input === 'string' ? input : input.url
    lastFetchInit = init
    return nextFetchResponse() as any
  }) as any
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  projectFixture = { id: 'p-1', name: 'Test', workspaceId: 'w-1' }
  memberFixture = { id: 'member-1' }
  hasBalanceResult = true
  hasAdvancedModelAccessResult = true
  resolvePodUrlResult = { url: 'http://runtime-p-1.local' }
  lastFetchUrl = null
  lastFetchInit = undefined
  setProjectUserCalls.length = 0
  nextFetchResponse = () =>
    new Response(JSON.stringify({ status: 'running' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
})

// Imports AFTER mocks.
const { projectChatRoutes } = await import('../routes/project-chat')

const runtimeManager: any = {
  status: (_id: string) => ({ status: 'running', url: 'http://localhost:5200', port: 5200 }),
  start: async () => ({ status: 'running' }),
  stop: async () => {},
}

function buildApp() {
  const app = new Hono()
  app.route('/api', projectChatRoutes({ runtimeManager }))
  return app
}

// =========================================================================
// primary chat proxy
// =========================================================================

describe('POST /projects/:projectId/chat', () => {
  test('404 when project does not exist', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-missing/chat', {
      method: 'POST',
      body: '{}',
    }))
    expect(res.status).toBe(404)
  })

  test('402 when the workspace has no remaining balance', async () => {
    hasBalanceResult = false
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat', {
      method: 'POST',
      body: '{}',
    }))
    expect(res.status).toBe(402)
    expect((await res.json() as any).error.code).toBe('usage_limit_reached')
  })

  test('503 with pod_starting when runtime URL resolution times out', async () => {
    resolvePodUrlResult = new Error('Timeout waiting for runtime')
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat', {
      method: 'POST',
      body: '{}',
    }))

    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body.error.code).toBe('pod_starting')
    expect(body.error.retryable).toBe(true)
  })

  test('streams a successful runtime response with trusted billing user and model downgrade', async () => {
    hasAdvancedModelAccessResult = false
    nextFetchResponse = () => new Response('data: {"type":"text","text":"hi"}\n\n', {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Content-Length': '999',
        'X-Turn-Id': 'turn-1',
      },
    })
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer user-session',
        'X-Session-Id': 'session-1',
      },
      body: JSON.stringify({
        chatSessionId: 'chat-1',
        userId: 'user-1',
        agentMode: 'advanced',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBeNull()
    expect(res.headers.get('X-Turn-Id')).toBe('turn-1')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(await res.text()).toContain('data:')
    expect(lastFetchUrl).toBe('http://runtime-p-1.local/agent/chat')
    const headers = new Headers(lastFetchInit?.headers)
    expect(headers.get('Authorization')).toBe('Bearer user-session')
    expect(headers.get('X-Session-Id')).toBe('session-1')
    expect(headers.get('X-Billing-User-Id')).toBe('user-1')
    expect(headers.get('X-User-Id')).toBe('user-1')
    expect(headers.get('x-runtime-token')).toBe('tok-1')
    expect(JSON.parse(String(lastFetchInit?.body)).agentMode).toBe('claude-haiku-4-5-20251001')
    expect(setProjectUserCalls).toEqual([{ projectId: 'p-1', userId: 'user-1' }])
  })

  test('does not forward X-User-Id when claimed user is not a workspace member', async () => {
    memberFixture = null
    nextFetchResponse = () => new Response('data: ok\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Billing-User-Id': 'outsider' },
      body: JSON.stringify({ chatSessionId: 'chat-1', messages: [] }),
    }))

    expect(res.status).toBe(200)
    await res.text()
    const headers = new Headers(lastFetchInit?.headers)
    expect(headers.get('X-Billing-User-Id')).toBe('outsider')
    expect(headers.get('X-User-Id')).toBeNull()
  })
})

// =========================================================================
// stream proxy
// =========================================================================

describe('GET /projects/:projectId/chat/:chatSessionId/stream', () => {
  test('404 when project does not exist', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-missing/chat/s-1/stream'))
    expect(res.status).toBe(404)
  })

  test('forwards 204 from the runtime', async () => {
    nextFetchResponse = () => new Response(null, { status: 204 })
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/s-1/stream'))
    expect(res.status).toBe(204)
  })

  test('forwards a streaming body and strips hop-by-hop headers', async () => {
    nextFetchResponse = () => new Response('data: hi\n\n', {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Transfer-Encoding': 'chunked',
        'X-Turn-Id': 'turn-7',
        'X-Last-Seq': '42',
      },
    })
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/s-1/stream?fromSeq=10'))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Turn-Id')).toBe('turn-7')
    expect(res.headers.get('X-Last-Seq')).toBe('42')
    // Hop-by-hop strip — we should not be forwarding Transfer-Encoding.
    expect(res.headers.get('Transfer-Encoding')).toBeNull()
    // fromSeq propagates to upstream URL.
    expect(lastFetchUrl).toContain('fromSeq=10')
  })

  test('returns 204 (best-effort) when runtime resolution throws', async () => {
    resolvePodUrlResult = new Error('runtime down')
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/s-1/stream'))
    expect(res.status).toBe(204)
  })
})

// =========================================================================
// turn snapshot
// =========================================================================

describe('GET /projects/:projectId/chat/:chatSessionId/turn', () => {
  test('404 when project does not exist', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-missing/chat/s-1/turn'))
    expect(res.status).toBe(404)
  })

  test('forwards a JSON snapshot from the runtime', async () => {
    nextFetchResponse = () => new Response(JSON.stringify({ status: 'in_progress', lastSeq: 5 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/s-1/turn'))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.status).toBe('in_progress')
    expect(body.lastSeq).toBe(5)
  })

  test('returns { status: "unknown" } when the upstream 404s', async () => {
    nextFetchResponse = () => new Response('not found', { status: 404 })
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/s-1/turn'))
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.status).toBe('unknown')
  })

  test('returns { status: "unknown" } when runtime resolution throws', async () => {
    resolvePodUrlResult = new Error('down')
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/s-1/turn'))
    expect(res.status).toBe(404)
  })
})

// =========================================================================
// stop / subagent stop
// =========================================================================

describe('POST /projects/:projectId/chat/stop', () => {
  test('404 when project does not exist', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-missing/chat/stop', { method: 'POST' }))
    expect(res.status).toBe(404)
  })

  test('forwards stop result from runtime', async () => {
    nextFetchResponse = () => new Response(JSON.stringify({ stopped: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'user' }),
    }))
    expect(res.status).toBe(200)
    expect((await res.json() as any).stopped).toBe(true)
  })

  test('500 when runtime resolution fails', async () => {
    resolvePodUrlResult = new Error('boom')
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }))
    expect(res.status).toBe(500)
  })
})

describe('POST /projects/:projectId/chat/subagents/:instanceId/stop', () => {
  test('404 when project does not exist', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-missing/chat/subagents/inst-1/stop', { method: 'POST' }))
    expect(res.status).toBe(404)
  })

  test('forwards subagent stop result', async () => {
    nextFetchResponse = () => new Response(JSON.stringify({ stopped: true, instanceId: 'inst-1' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/subagents/inst-1/stop', { method: 'POST' }))
    expect(res.status).toBe(200)
    expect((await res.json() as any).instanceId).toBe('inst-1')
  })
})

// =========================================================================
// permission-response
// =========================================================================

describe('POST /projects/:projectId/permission-response', () => {
  test('forwards permission result', async () => {
    nextFetchResponse = () => new Response(JSON.stringify({ accepted: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/permission-response', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    }))
    expect(res.status).toBe(200)
  })

  test('503 when runtime is unreachable (ECONNREFUSED-shaped error)', async () => {
    resolvePodUrlResult = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/permission-response', {
      method: 'POST', body: '{}',
    }))
    expect(res.status).toBe(503)
  })

  test('500 on other proxy errors', async () => {
    resolvePodUrlResult = new Error('unexpected')
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/permission-response', {
      method: 'POST', body: '{}',
    }))
    expect(res.status).toBe(500)
  })
})

// =========================================================================
// status (local-mode branch)
// =========================================================================

describe('GET /projects/:projectId/chat/status', () => {
  test('404 when project does not exist', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-missing/chat/status'))
    expect(res.status).toBe(404)
  })

  test('returns local-mode shape when a runtimeManager is configured', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/status'))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.mode).toBe('local')
    expect(body.ready).toBe(true)
    expect(body.url).toBe('http://localhost:5200')
  })

  test('reports "stopped" when the local runtime has no entry', async () => {
    const rm: any = { status: () => null, start: async () => ({}), stop: async () => {} }
    const app = new Hono()
    app.route('/api', projectChatRoutes({ runtimeManager: rm }))
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/status'))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.mode).toBe('local')
    expect(body.exists).toBe(false)
    expect(body.status).toBe('stopped')
  })

  test('returns mode=none when no runtimeManager is configured (and not in K8s)', async () => {
    const app = new Hono()
    app.route('/api', projectChatRoutes({}))
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/status'))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.mode).toBe('none')
    expect(body.message).toContain('No runtime manager')
  })
})

// =========================================================================
// wake
// =========================================================================

describe('POST /projects/:projectId/chat/wake', () => {
  test('404 when project does not exist', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-missing/chat/wake', { method: 'POST' }))
    expect(res.status).toBe(404)
  })

  test('returns the resolved URL on success', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/wake', { method: 'POST' }))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.success).toBe(true)
    expect(body.url).toBe('http://runtime-p-1.local')
  })

  test('500 when project URL resolution fails', async () => {
    resolvePodUrlResult = new Error('still booting')
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-1/chat/wake', { method: 'POST' }))
    expect(res.status).toBe(500)
  })
})
