// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance — SHO-166: `model: "auto"` on every `/ai/v1` text endpoint.
 *
 * The card's bug is the 400 `model_not_found` on `{"model":"auto"}`. The
 * dev-side tests cover the plain cloud gateway; this file covers the half
 * that runs on a **cloud-forwarding desktop**, where the new code has a
 * second job: rewrite the body so a cloud that has not shipped `auto` yet
 * never sees the literal string. That rewrite (the Anthropic `/messages`
 * branch especially) is the one new code path with no other test.
 *
 * Acceptance criteria exercised here:
 *   AC1  chat/completions with `auto` is accepted, not `model_not_found`
 *   AC4a a forwarding desktop sends the connected cloud's Auto standard id
 *        on chat/completions, Responses and Anthropic `/messages`
 *   AC4b cloud map unreachable → the local Auto standard default, still a
 *        concrete id
 *   AC6  `basic` / concrete ids forward exactly as before, and a body with no
 *        `model` is not given one
 *
 * No provider and no cloud is called: `fetch` is stubbed.
 *
 *   bun test apps/api/src/__tests__/qa-sho166-auto-model.acceptance.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET = 'qa-sho166-secret'
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.SHOGO_API_KEY = 'shogo_sk_qa_sho166'
process.env.SHOGO_CLOUD_URL = 'https://cloud.example/'
delete process.env.AI_MODE
delete process.env.LOCAL_LLM_BASE_URL
delete process.env.LOCAL_LLM_BASIC_MODEL

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    platformSetting: { findUnique: async () => null, findMany: async () => [] },
    localConfig: { findUnique: async () => null },
    modelDefinition: { findMany: async () => [] },
    modelProvider: { findMany: async () => [] },
    workspaceModelVisibility: { findMany: async () => [] },
    usageEvent: { create: async () => ({}) },
    usageWallet: {
      findUnique: async () => null,
      create: async (args: any) => args.data,
      upsert: async (args: any) => args.create,
    },
    subscription: { findFirst: async () => null },
  },
}))

mock.module('../services/billing.service', () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  ensureSystemWorkspace: async () => {},
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => true,
  checkUsageBalance: async () => ({ ok: true, remainingIncludedUsd: 100 }),
  usageLimitErrorPayload: (reason?: string) => ({ code: reason ?? 'usage_limit_reached', message: 'usage limit reached' }),
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 100 }),
  getSubscription: async () => null,
  getUsageWallet: async () => null,
}))

const billingRuntime = await import('../services/billing-runtime')
mock.module('../services/billing-runtime', () => ({
  ...billingRuntime,
  hasAdvancedModelAccess: async () => true,
}))

mock.module('../lib/proxy-capture', () => ({
  beginCapture: async () => null,
  updateTurnFeedback: async () => {},
  markProjectTurnsReverted: async () => {},
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  hasActiveSession: () => false,
  accumulateUsage: () => {},
  accumulateImageUsage: () => {},
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({ getProjectUser: () => 'user-1' }))

mock.module('../lib/cloud-key-wipe', () => ({
  wipeCloudKey: async () => {},
  wipeCloudKeyIfRejected: async () => ({ wiped: false }),
}))

// ─── Stubbed fetch: the cloud maps + the cloud proxy answer ───────────────
const originalFetch = globalThis.fetch
interface UpstreamCall { url: string; body: any }
let upstreamCalls: UpstreamCall[] = []
/** Response the cloud's `/api/platform/agent-model-defaults` returns. */
let cloudDefaultsResponse: () => Response = () => new Response('{}', { status: 404 })
/** Response the cloud AI proxy returns for the forwarded request. */
let cloudProxyResponse: () => Response = () => new Response('{}', { status: 200 })

function cloudAgentModelDefaults(standard: string) {
  return new Response(JSON.stringify({
    basic: 'cloud-basic-model',
    advanced: 'cloud-advanced-model',
    defaultMode: 'auto',
    autoTiers: {
      economy: { id: 'cloud-economy-model' },
      standard: { id: standard },
      premium: { id: 'cloud-premium-model' },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('/api/platform/agent-model-defaults')) return cloudDefaultsResponse()
    let body: any
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined } catch { body = init?.body }
    upstreamCalls.push({ url, body })
    return cloudProxyResponse()
  }) as any
})

afterAll(() => { globalThis.fetch = originalFetch })

// ─── Imports AFTER the mocks ──────────────────────────────────────────────
const { Hono } = await import('hono')
const { AGENT_MODE_DEFAULTS } = await import('@shogo/model-catalog')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { _resetAgentModelDefaultsCache } = await import('../lib/federated-upstream')

const CLOUD_STANDARD = 'cloud-auto-standard-model'
/** `AUTO_MODEL_DEFAULTS.standard` — the local fallback when the map is unavailable. */
const LOCAL_STANDARD_DEFAULT = 'claude-haiku-4-5-20251001'

let TOKEN = ''
beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
})

beforeEach(() => {
  upstreamCalls = []
  _resetAgentModelDefaultsCache()
  cloudDefaultsResponse = () => cloudAgentModelDefaults(CLOUD_STANDARD)
  cloudProxyResponse = () => new Response(JSON.stringify({
    id: 'cmpl_cloud_ok',
    model: 'whatever-the-cloud-picked',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
})

function buildApp() {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  return app
}

function postChat(model: string, extra: Record<string, unknown> = {}) {
  return buildApp().fetch(new Request('http://x/api/ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }),
  }))
}

function postResponses(model: string) {
  return buildApp().fetch(new Request('http://x/api/ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model, input: 'hi' }),
  }))
}

function postAnthropic(body: Record<string, unknown>) {
  return buildApp().fetch(new Request('http://x/api/ai/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ max_tokens: 32, messages: [{ role: 'user', content: 'hi' }], ...body }),
  }))
}

/** The one request that left this instance for the cloud AI proxy. */
function forwardedCall(): UpstreamCall | undefined {
  return upstreamCalls.filter((call) => !call.url.includes('/api/platform/agent-model-defaults')).at(-1)
}

describe('SHO-166 — a cloud-forwarding desktop never forwards the literal "auto"', () => {
  // AC1 + AC4a — the card's repro, on the desktop shape.
  test('chat/completions accepts "auto" and forwards the cloud Auto standard id', async () => {
    const res = await postChat('auto')

    expect(res.status).toBe(200)
    const payload = await res.json() as any
    expect(payload.error?.code).not.toBe('model_not_found')
    expect(forwardedCall()?.url).toBe('https://cloud.example/api/ai/v1/chat/completions')
    expect(forwardedCall()?.body.model).toBe(CLOUD_STANDARD)
  })

  // AC4a — Responses was hoisted to the same helper.
  test('responses forwards the cloud Auto standard id', async () => {
    const res = await postResponses('auto')

    expect(res.status).toBe(200)
    expect(forwardedCall()?.url).toBe('https://cloud.example/api/ai/v1/responses')
    expect(forwardedCall()?.body.model).toBe(CLOUD_STANDARD)
  })

  // AC4a — the Anthropic branch resolves, then rewrites the forwarded body.
  test('anthropic /messages forwards the cloud Auto standard id in the rewritten body', async () => {
    const res = await postAnthropic({ model: 'auto' })

    expect(res.status).toBe(200)
    expect(forwardedCall()?.url).toBe('https://cloud.example/api/ai/anthropic/v1/messages')
    expect(forwardedCall()?.body.model).toBe(CLOUD_STANDARD)
    expect(forwardedCall()?.body.model).not.toBe('auto')
    // The rewrite must not drop what the client sent.
    expect(forwardedCall()?.body.max_tokens).toBe(32)
    expect(forwardedCall()?.body.messages).toHaveLength(1)
  })

  // AC4b — an unreachable cloud map still leaves this instance sending a
  // concrete id, never `auto`.
  test('falls back to the local Auto standard default when the cloud map is unavailable', async () => {
    cloudDefaultsResponse = () => new Response('{}', { status: 404 })

    const res = await postChat('auto')

    expect(res.status).toBe(200)
    expect(forwardedCall()?.body.model).toBe(LOCAL_STANDARD_DEFAULT)
  })

  // AC6 — the rewrite only rewrites what needs it: `basic` keeps resolving to
  // the same model it always ran on (now spelled out), and a concrete id is
  // forwarded untouched.
  test('basic and concrete ids still forward the model they always ran on', async () => {
    const basic = await postAnthropic({ model: 'basic' })
    expect(basic.status).toBe(200)
    expect(forwardedCall()?.body.model).toBe(AGENT_MODE_DEFAULTS.basic)

    const concrete = await postAnthropic({ model: 'claude-sonnet-4-6' })
    expect(concrete.status).toBe(200)
    expect(forwardedCall()?.body.model).toBe('claude-sonnet-4-6')
  })

  // AC6 — no `model` in the body must stay "no model", not become one.
  test('a body without a model is not given one by the rewrite', async () => {
    const res = await postAnthropic({})

    expect(res.status).toBe(200)
    expect(forwardedCall()?.body).not.toHaveProperty('model')
  })

  // AC1 — streaming must resolve too (the iOS CI step may stream).
  test('streaming chat/completions carries the resolved id upstream', async () => {
    cloudProxyResponse = () => new Response([
      'data: {"id":"cmpl_stream","choices":[{"delta":{"content":"ok"}}]}',
      '',
    ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

    const res = await postChat('auto', { stream: true })

    expect(res.status).toBe(200)
    expect(forwardedCall()?.body.model).toBe(CLOUD_STANDARD)
    expect(forwardedCall()?.body.stream).toBe(true)
  })
})
