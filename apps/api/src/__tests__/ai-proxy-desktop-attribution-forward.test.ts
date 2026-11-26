// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-590 §A, desktop side — a paired desktop that forwards a model call names
 * the workspace, project and person the turn belongs to.
 *
 * The cloud meters a forwarded call to the device key's workspace unless the
 * request says otherwise, so every cloud-forward path has to carry the local
 * token payload's context. This file pins that for all four families:
 *   • chat completions, responses and Anthropic messages (each rewrites its own
 *     body, so each forwards itself);
 *   • the media / 3D / audio family that goes through `forwardToShogoCloud`.
 *
 * Sentinels are not projects: a workspace-level token (`projectId:
 * 'workspace'`) must not claim one, or the cloud records a project id that has
 * no row.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-desktop-attribution-forward.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// Desktop in cloud-forwarding mode: the local proxy has no provider keys, so
// every model call is relayed to Shogo Cloud with the device key.
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.SHOGO_API_KEY = 'shogo_sk_test_device_key'
process.env.SHOGO_CLOUD_URL = 'http://cloud.test'
process.env.AI_PROXY_SECRET = 'shogo-590-test-proxy-secret'
process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
delete process.env.AI_MODE

const CLOUD = 'http://cloud.test'
const WORKSPACE = 'ws-local-host'
const PROJECT = 'proj-local-host'
const USER = 'user-local'

/**
 * Every lookup returns "nothing here": the paths under test either fall back to
 * a default (model resolution, model gate) or are not reached at all before the
 * forward.
 */
function emptyModel() {
  return {
    findUnique: async () => null,
    findFirst: async () => null,
    findMany: async () => [],
    create: async ({ data }: any) => data,
    update: async ({ data }: any) => data,
    upsert: async ({ create }: any) => create,
    count: async () => 0,
    delete: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
  }
}

const prismaStub: any = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (prop === '$transaction') return async (fn: any) => fn(prismaStub)
      if (prop === '$queryRaw') return async () => []
      if (prop === '$executeRaw') return async () => 0
      return emptyModel()
    },
  },
)

mock.module('../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))

const fetchCalls: { url: string; headers: Record<string, string>; body: any }[] = []
const originalFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers ?? {}).forEach((value, name) => {
      headers[name.toLowerCase()] = value
    })
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    fetchCalls.push({ url: String(url), headers, body })
    return new Response(
      JSON.stringify({
        id: 'msg_local',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'from cloud' }],
        choices: [{ index: 0, message: { role: 'assistant', content: 'from cloud' }, finish_reason: 'stop' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as any
})

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')

let token: string

beforeEach(async () => {
  fetchCalls.length = 0
  token = await generateProxyToken(PROJECT, WORKSPACE, USER)
})

async function post(path: string, body: unknown, auth: 'bearer' | 'x-api-key' = 'bearer', extra: Record<string, string> = {}) {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-chat-session-id': 'chat-local',
    ...extra,
  }
  if (auth === 'bearer') headers.Authorization = `Bearer ${token}`
  else headers['x-api-key'] = token
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  )
}

/** The one cloud call this request made, with its headers. */
function cloudCall(pathname: string) {
  const call = fetchCalls.find((c) => c.url === `${CLOUD}/api${pathname}`)
  expect(call).toBeDefined()
  return call!
}

const ATTRIBUTION = {
  'x-shogo-workspace-id': WORKSPACE,
  'x-shogo-project-id': PROJECT,
  'x-shogo-member-id': USER,
}

describe('SHO-590 §A: every cloud-forward path names the workspace, project and person', () => {
  test('chat completions', async () => {
    const res = await post('/api/ai/v1/chat/completions', {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    })
    expect(res.status).toBe(200)

    const call = cloudCall('/ai/v1/chat/completions')
    for (const [name, value] of Object.entries(ATTRIBUTION)) {
      expect(call.headers[name]).toBe(value)
    }
    // The chat is what groups the turn in the cloud's ledger.
    expect(call.headers['x-chat-session-id']).toBe('chat-local')
    // …and the device key is still the credential the cloud bills by.
    expect(call.headers['authorization']).toBe(`Bearer ${process.env.SHOGO_API_KEY}`)
  })

  test('responses', async () => {
    const res = await post('/api/ai/v1/responses', { model: 'claude-haiku-4-5', input: 'hi' })
    expect(res.status).toBe(200)

    const call = cloudCall('/ai/v1/responses')
    for (const [name, value] of Object.entries(ATTRIBUTION)) {
      expect(call.headers[name]).toBe(value)
    }
    expect(call.headers['x-chat-session-id']).toBe('chat-local')
  })

  test('anthropic messages (x-api-key)', async () => {
    const res = await post(
      '/api/ai/anthropic/v1/messages',
      { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 },
      'x-api-key',
      { 'anthropic-version': '2023-06-01' },
    )
    expect(res.status).toBe(200)

    const call = cloudCall('/ai/anthropic/v1/messages')
    for (const [name, value] of Object.entries(ATTRIBUTION)) {
      expect(call.headers[name]).toBe(value)
    }
    expect(call.headers['x-chat-session-id']).toBe('chat-local')
  })

  test('the media family (forwardToShogoCloud) carries them too', async () => {
    const res = await post('/api/ai/v1/images/generations', { model: 'nano-banana', prompt: 'a red door' })
    expect(res.status).toBe(200)

    const call = cloudCall('/ai/v1/images/generations')
    for (const [name, value] of Object.entries(ATTRIBUTION)) {
      expect(call.headers[name]).toBe(value)
    }
    expect(call.headers['x-chat-session-id']).toBe('chat-local')
  })

  test('a workspace-level token claims no project', async () => {
    token = await generateProxyToken('workspace', WORKSPACE, USER)
    const res = await post('/api/ai/v1/chat/completions', {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    })
    expect(res.status).toBe(200)

    const call = cloudCall('/ai/v1/chat/completions')
    expect(call.headers['x-shogo-workspace-id']).toBe(WORKSPACE)
    expect(call.headers['x-shogo-member-id']).toBe(USER)
    // `'workspace'` is a sentinel, not a Project row — the cloud would record a
    // project id that does not exist.
    expect(call.headers['x-shogo-project-id']).toBeUndefined()
  })

  test('a token without a user sends no person, never a guess', async () => {
    token = await generateProxyToken(PROJECT, WORKSPACE)
    const res = await post('/api/ai/v1/chat/completions', {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    })
    expect(res.status).toBe(200)

    const call = cloudCall('/ai/v1/chat/completions')
    expect(call.headers['x-shogo-workspace-id']).toBe(WORKSPACE)
    expect(call.headers['x-shogo-member-id']).toBeUndefined()
  })
})

// Leave the process as we found it for the next test file.
globalThis.fetch = originalFetch
