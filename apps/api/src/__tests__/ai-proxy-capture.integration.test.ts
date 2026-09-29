// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Integration coverage for the route-to-capture boundary.
 *
 * These tests mount the real AI proxy routes, use the real capture
 * normalization/reassembly/archive queue, and replace only external systems:
 * Prisma, the provider network, and S3.
 */

import { gunzipSync } from 'node:zlib'
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET = 'proxy-capture-integration-secret'
process.env.BETTER_AUTH_SECRET = 'proxy-capture-integration-better-auth-secret'
process.env.PROXY_CAPTURE_ENABLED = 'true'
process.env.REGION_ID = 'test-region'
delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
delete process.env.SHOGO_CLOUD_URL
process.env.OPENAI_API_KEY = 'sk-openai-proxy-capture-test'

let trainingDataMode: 'default' | 'enabled' | 'disabled' = 'enabled'
const summaryUpserts: any[] = []
const objectWrites: Array<{ Bucket: string; Key: string; Body: Buffer; ContentType?: string }> = []

const workspaceFindUnique = mock(async () => ({ trainingDataMode }))
const proxyTurnUpsert = mock(async (args: any) => {
  summaryUpserts.push(args)
  return args.create
})

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    workspace: { findUnique: workspaceFindUnique },
    workspaceModelVisibility: { findMany: async () => [] },
    proxyTurn: { upsert: proxyTurnUpsert },
    project: {
      findFirst: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    usageEvent: { create: async () => ({}) },
    usageWallet: {
      findUnique: async () => null,
      create: async (args: any) => args.data,
      update: async (args: any) => args.data,
      upsert: async (args: any) => args.create,
    },
    subscription: { findFirst: async () => null, upsert: async () => ({}) },
  },
}))

mock.module('../services/billing.service', () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  getEffectivePlanId: async () => 'pro',
  hasBalance: async () => true,
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: (reason?: string) => ({
    code: reason ?? 'usage_limit_reached',
    message: 'usage limit reached',
  }),
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 100 }),
  getSubscription: async () => null,
  getUsageWallet: async () => null,
  getUsageWindows: async () => ({
    fiveHour: { kind: 'five_hour', usedUsd: 0, limitUsd: null, utilization: 0, resetsAt: null },
    weekly: { kind: 'weekly', usedUsd: 0, limitUsd: null, utilization: 0, resetsAt: null },
  }),
  ensureSystemWorkspace: async () => {},
  syncFromStripe: async () => {},
  allocateMonthlyIncluded: async () => {},
  hasPaidSubscription: async () => true,
  canRunTechStackOnInstanceSize: async () => ({
    allowed: true,
    currentSize: 'micro',
    requiredSize: null,
  }),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  hasActiveSession: () => false,
  accumulateUsage: async () => false,
  accumulateImageUsage: async () => false,
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'user-1',
}))

mock.module('../lib/cloud-key-wipe', () => ({
  wipeCloudKey: async () => {},
}))

// The route import reaches the worker runtime manager through the normal
// application module graph. This package is absent in the lightweight test
// checkout, but it is unrelated to proxy handling.
mock.module('@shogo-ai/sdk/vite-watch', () => ({
  killViteWatchFromPidfile: () => {},
}))

class FakePutObjectCommand {
  input: any

  constructor(input: any) {
    this.input = input
  }
}

class FakeS3Command {
  input: any

  constructor(input: any) {
    this.input = input
  }
}

class FakeS3Client {
  constructor(_config?: any) {}

  async send(command: any) {
    objectWrites.push(command.input)
    return {}
  }
}

mock.module('@aws-sdk/client-s3', () => ({
  S3Client: FakeS3Client,
  GetObjectCommand: FakeS3Command,
  ListObjectsV2Command: FakeS3Command,
  HeadObjectCommand: FakeS3Command,
  DeleteObjectCommand: FakeS3Command,
  CopyObjectCommand: FakeS3Command,
  PutObjectCommand: FakePutObjectCommand,
}))

mock.module('../lib/s3', () => ({
  getLlmCaptureBucket: () => 'llm-captures-test',
  getS3Client: () => ({
    send: async (command: FakePutObjectCommand) => {
      objectWrites.push(command.input)
      return {}
    },
  }),
}))

let nextFetchResponses: Array<() => Response> = []
let lastFetchUrl: string | null = null
let lastFetchInit: RequestInit | undefined
const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  lastFetchUrl = typeof input === 'string' ? input : input.url
  lastFetchInit = init
  const next = nextFetchResponses.shift()
  if (next) return next()
  throw new Error(`Unexpected provider request: ${typeof input === 'string' ? input : input.url}`)
}) as any

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { clearConsentCache } = await import('../lib/proxy-capture')
const { flushArchive } = await import('../lib/proxy-capture/archive-writer')

const TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')

function buildApp() {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  return app
}

async function postChat(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return buildApp().fetch(new Request('http://test/api/ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  }))
}

async function flushAndReadArchive(): Promise<any> {
  await flushArchive()
  const archive = objectWrites
    .filter((write) => write.ContentType === 'application/jsonl')
    .at(-1)
  if (!archive) return null
  return JSON.parse(gunzipSync(archive.Body).toString('utf8').trim())
}

beforeEach(() => {
  trainingDataMode = 'enabled'
  summaryUpserts.length = 0
  objectWrites.length = 0
  nextFetchResponses = []
  lastFetchUrl = null
  lastFetchInit = undefined
  workspaceFindUnique.mockClear()
  proxyTurnUpsert.mockClear()
  process.env.PROXY_CAPTURE_ENABLED = 'true'
  delete process.env.SHOGO_LOCAL_MODE
  delete process.env.SHOGO_API_KEY
  delete process.env.SHOGO_CLOUD_URL
  clearConsentCache()
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe('AI proxy capture integration', () => {
  test('captures a direct non-streaming completion, scrubs secrets, and persists a turn summary', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({
      id: 'chatcmpl_capture',
      choices: [{
        message: { role: 'assistant', content: 'captured answer' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const response = await postChat(
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'hello capture' },
        ],
      },
      {
        'x-chat-session-id': 'chat-capture-1',
        'x-api-key': 'provider-secret',
        Cookie: 'session=secret',
      },
    )

    expect(response.status).toBe(200)
    expect((await response.json() as any).choices[0].message.content).toBe('captured answer')

    const archive = await flushAndReadArchive()
    expect(archive).not.toBeNull()
    expect(archive.source).toBe('cloud_runtime')
    expect(archive.endpoint).toBe('chat.completions')
    expect(archive.stream).toBe(false)
    expect(archive.request.messages[0]).toEqual({
      role: 'system',
      content: 'You are a helpful assistant.',
    })
    expect(archive.response.choices[0].message.content).toBe('captured answer')
    expect(archive.requestHeaders.Authorization).toBeUndefined()
    expect(archive.requestHeaders['x-api-key']).toBeUndefined()
    expect(archive.requestHeaders.Cookie).toBeUndefined()

    expect(summaryUpserts).toHaveLength(1)
    expect(summaryUpserts[0].create).toMatchObject({
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      userId: 'user-1',
      chatSessionId: 'chat-capture-1',
      source: 'cloud_runtime',
      resolvedModel: 'gpt-4o-mini',
      inputTokens: 9,
      outputTokens: 4,
      cachedInputTokens: 2,
      userText: 'hello capture',
      assistantText: 'captured answer',
      hadError: false,
    })
  })

  test('tees a streaming completion and reassembles assistant text, reasoning, and usage', async () => {
    nextFetchResponses.push(() => new Response([
      'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"plan "}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"then answer","content":"hello "}}]}',
      'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":6,"prompt_tokens_details":{"cached_tokens":3}}}',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))

    const response = await postChat({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'stream capture' }],
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('hello ')

    const archive = await flushAndReadArchive()
    expect(archive.stream).toBe(true)
    expect(archive.response.content).toBe('hello world')
    expect(archive.response.reasoning_content).toBe('plan then answer')
    expect(archive.usage).toEqual({
      inputTokens: 12,
      outputTokens: 6,
      cachedInputTokens: 3,
    })
    expect(summaryUpserts[0].create).toMatchObject({
      userText: 'stream capture',
      assistantText: 'hello world',
      inputTokens: 12,
      outputTokens: 6,
      cachedInputTokens: 3,
    })
  })

  test('honors the workspace training-data kill switch while preserving the completion response', async () => {
    trainingDataMode = 'disabled'
    nextFetchResponses.push(() => new Response(JSON.stringify({
      id: 'chatcmpl_disabled',
      choices: [{ message: { role: 'assistant', content: 'still works' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const response = await postChat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'do not capture this' }],
    })

    expect(response.status).toBe(200)
    expect((await response.json() as any).id).toBe('chatcmpl_disabled')
    expect(await flushAndReadArchive()).toBeNull()
    expect(summaryUpserts).toHaveLength(0)
  })

  test('forwards desktop cloud-proxy traffic with its client marker and does not capture locally', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    process.env.SHOGO_API_KEY = 'shogo_sk_desktop-test'
    process.env.SHOGO_CLOUD_URL = 'https://cloud.example/'
    nextFetchResponses.push(() => new Response(JSON.stringify({
      id: 'chatcmpl_cloud',
      choices: [{ message: { role: 'assistant', content: 'cloud response' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const response = await postChat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'desktop request' }],
    })

    expect(response.status).toBe(200)
    expect((await response.json() as any).id).toBe('chatcmpl_cloud')
    expect(lastFetchUrl).toBe('https://cloud.example/api/ai/v1/chat/completions')
    expect(new Headers(lastFetchInit?.headers).get('x-shogo-client')).toBe('desktop')
    expect(new Headers(lastFetchInit?.headers).get('Authorization')).toBe('Bearer shogo_sk_desktop-test')
    expect(await flushAndReadArchive()).toBeNull()
    expect(summaryUpserts).toHaveLength(0)
  })
})
