// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * AI Proxy — `model: "auto"` on the text endpoints (SHO-166).
 *
 * Every other Shogo surface accepts `auto`, but the gateway only mapped
 * `basic`/`advanced`, so `auto` fell through to `resolveModel('auto')` and
 * 400'd with `model_not_found`. It now resolves through `resolveAutoTierModel`
 * (the same map agent runtimes are spawned with) before anything reads
 * `request.model`.
 *
 * The Auto map is exercised for real — admin overrides via
 * `setAutoTierOverrides`, the entitlement cap via the billing seam, the cloud
 * map via the federated upstream call — and only `fetch` is stubbed, so no
 * provider is ever called.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-auto-model.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET = 'auto-model-test-secret'
process.env.ANTHROPIC_API_KEY = 'sk-ant-auto-model-test'
process.env.OPENAI_API_KEY = 'sk-openai-auto-model-test'

// Cloud defaults: not a local instance, no cloud key, no local LLM — the
// "cloud" half of AC1-AC3 and AC5-AC6.
function cloudMode() {
  delete process.env.SHOGO_LOCAL_MODE
  delete process.env.SHOGO_API_KEY
  delete process.env.SHOGO_CLOUD_URL
  delete process.env.AI_MODE
  delete process.env.LOCAL_LLM_BASE_URL
  delete process.env.LOCAL_LLM_BASIC_MODEL
}
cloudMode()

/** Plan entitlement behind `isModelAccessibleForWorkspace` (AC3). */
let advancedAccess = true
/** Billing rows written by `recordUsage` (AC1: billed under the resolved id). */
let consumedUsage: any[] = []

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    platformSetting: { findUnique: async () => null },
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
  hasAdvancedModelAccess: async () => advancedAccess,
  checkUsageBalance: async () => ({ ok: true, remainingIncludedUsd: 100 }),
  usageLimitErrorPayload: (reason?: string) => ({
    code: reason ?? 'usage_limit_reached',
    message: 'usage limit reached',
  }),
  consumeUsage: async (args: any) => {
    consumedUsage.push(args)
    return { success: true, remainingIncludedUsd: 100 }
  },
  getSubscription: async () => null,
  getUsageWallet: async () => null,
}))

const billingRuntime = await import('../services/billing-runtime')
mock.module('../services/billing-runtime', () => ({
  ...billingRuntime,
  hasAdvancedModelAccess: async () => advancedAccess,
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

// ─── Stub fetch, capture the upstream call ────────────────────────────────
const originalFetch = globalThis.fetch
let fetchCalls: { url: string; init?: RequestInit }[] = []
let fetchQueue: Array<() => Response> = []

function anthropicMessage(model: string) {
  return new Response(JSON.stringify({
    id: 'msg_auto',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 11, output_tokens: 4 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function openAIChatCompletion(model: string) {
  return new Response(JSON.stringify({
    id: 'cmpl_auto',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function openAIResponse(model: string) {
  return new Response(JSON.stringify({
    id: 'resp_auto',
    object: 'response',
    model,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: 11, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** The cloud `GET /api/platform/agent-model-defaults` answer (AC4a). */
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
    fetchCalls.push({ url, init })
    const scripted = fetchQueue.shift()
    if (scripted) return scripted()
    if (url.includes('/api/platform/agent-model-defaults')) {
      return new Response('{}', { status: 404 })
    }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (url.includes('api.anthropic.com')) return anthropicMessage(body.model)
    if (url.includes('/v1/responses')) return openAIResponse(body.model)
    return openAIChatCompletion(body.model)
  }) as any
})

afterAll(() => { globalThis.fetch = originalFetch })

// ─── Imports AFTER the mocks ──────────────────────────────────────────────
const { Hono } = await import('hono')
const { AGENT_MODE_DEFAULTS, setAutoTierOverrides } = await import('@shogo/model-catalog')
const { aiProxyRoutes, resolveRequestModel } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')

/** Package default for the Auto standard tier (`AUTO_MODEL_DEFAULTS.standard`). */
const AUTO_STANDARD_DEFAULT = 'claude-haiku-4-5-20251001'
/** Package default for the Auto economy tier — the entitlement fallback. */
const AUTO_ECONOMY_DEFAULT = 'gpt-5.4-nano'

function buildApp() {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  return app
}

let TOKEN = ''
beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
})

beforeEach(() => {
  fetchCalls = []
  fetchQueue = []
  advancedAccess = true
  consumedUsage = []
  setAutoTierOverrides({})
  cloudMode()
})

function postChat(app: any, model: string) {
  return app.fetch(new Request('http://x/api/ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  }))
}

function postResponses(app: any, model: string) {
  return app.fetch(new Request('http://x/api/ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model, input: 'hi' }),
  }))
}

function postAnthropic(app: any, model: string) {
  return app.fetch(new Request('http://x/api/ai/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
  }))
}

/** The upstream call that actually carried the completion. */
function upstreamCall() {
  return fetchCalls.filter((call) => !call.url.includes('/api/platform/agent-model-defaults')).at(-1)
}

function upstreamBody(): any {
  const raw = upstreamCall()?.init?.body
  return typeof raw === 'string' ? JSON.parse(raw) : undefined
}

describe('resolveRequestModel', () => {
  // AC2 — no admin override → the package default.
  test('resolves auto to the Auto standard tier package default', async () => {
    const { resolvedModel, isLocal } = await resolveRequestModel('auto', 'ws-1')
    expect(resolvedModel).toBe(AUTO_STANDARD_DEFAULT)
    expect(isLocal).toBe(false)
  })

  // AC2 — `getAutoTierOverrides().standard` wins.
  test('honors the admin Auto standard override', async () => {
    setAutoTierOverrides({ standard: 'gpt-5.4-mini' })
    expect((await resolveRequestModel('auto', 'ws-1')).resolvedModel).toBe('gpt-5.4-mini')
  })

  // AC3 — the configured standard model is not entitled → the same fallback
  // `resolveEffectiveAgentModelDefaults` applies, not a plan error.
  test('falls back when the workspace is not entitled to the configured standard model', async () => {
    setAutoTierOverrides({ standard: 'claude-sonnet-4-6' })
    advancedAccess = false
    const { resolvedModel } = await resolveRequestModel('auto', 'ws-1')
    expect(resolvedModel).not.toBe('claude-sonnet-4-6')
    expect(resolvedModel).toBe(AUTO_ECONOMY_DEFAULT)
  })

  // AC4b — offline local instance (no cloud key): local settings resolve it.
  test('resolves auto from local settings when the cloud is unreachable', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    setAutoTierOverrides({ standard: 'gpt-5.4-mini' })
    expect((await resolveRequestModel('auto', 'ws-1')).resolvedModel).toBe('gpt-5.4-mini')
  })

  // AC6 — everything else keeps its old meaning.
  test('leaves basic, advanced, concrete and openrouter ids untouched', async () => {
    expect((await resolveRequestModel('basic', 'ws-1')).resolvedModel).toBe(AGENT_MODE_DEFAULTS.basic)
    expect((await resolveRequestModel('advanced', 'ws-1')).resolvedModel).toBe(AGENT_MODE_DEFAULTS.advanced)
    expect((await resolveRequestModel('claude-sonnet-4-6', 'ws-1')).resolvedModel).toBe('claude-sonnet-4-6')
    const openrouter = 'openrouter:meta-llama/llama-3.1-405b-instruct'
    expect((await resolveRequestModel(openrouter, 'ws-1')).resolvedModel).toBe(openrouter)
  })
})

describe('POST /ai/v1/chat/completions with model "auto"', () => {
  // AC1
  test('returns 200, calls the Auto standard model and bills under that id', async () => {
    const res = await postChat(buildApp(), 'auto')
    expect(res.status).toBe(200)
    expect(upstreamCall()?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(upstreamBody()?.model).toBe(AUTO_STANDARD_DEFAULT)
    expect(consumedUsage).toHaveLength(1)
    expect(consumedUsage[0].actionMetadata.model).toBe(AUTO_STANDARD_DEFAULT)
  })

  // AC2
  test('sends the admin-overridden standard model upstream', async () => {
    setAutoTierOverrides({ standard: 'gpt-5.4-mini' })
    const res = await postChat(buildApp(), 'auto')
    expect(res.status).toBe(200)
    expect(upstreamCall()?.url).toContain('api.openai.com')
    expect(upstreamBody()?.model).toBe('gpt-5.4-mini')
  })

  // AC3
  test('does not 403 a free workspace whose configured standard model is not entitled', async () => {
    setAutoTierOverrides({ standard: 'claude-sonnet-4-6' })
    advancedAccess = false
    const res = await postChat(buildApp(), 'auto')
    expect(res.status).toBe(200)
    expect(upstreamBody()?.model).toBe(AUTO_ECONOMY_DEFAULT)
  })

  // AC6
  test('keeps basic, advanced and concrete ids working unchanged', async () => {
    const basic = await postChat(buildApp(), 'basic')
    expect(basic.status).toBe(200)
    expect(upstreamBody()?.model).toBe(AGENT_MODE_DEFAULTS.basic)

    const concrete = await postChat(buildApp(), 'claude-sonnet-4-6')
    expect(concrete.status).toBe(200)
    expect(upstreamBody()?.model).toBe('claude-sonnet-4-6')
  })
})

describe('cloud-forwarding desktop', () => {
  // AC4a — the cloud's Auto map, forwarded as a concrete id.
  test('forwards the cloud standard model, never the string "auto"', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    process.env.SHOGO_API_KEY = 'shogo_sk_auto_model_test'
    process.env.SHOGO_CLOUD_URL = 'https://cloud.example'
    fetchQueue.push(() => cloudAgentModelDefaults('cloud-standard-model'))

    const res = await postChat(buildApp(), 'auto')
    expect(res.status).toBe(200)

    const forwardedUrl = upstreamCall()?.url
    expect(forwardedUrl).toContain('/api/ai/v1/chat/completions')
    const forwarded = JSON.parse(String(upstreamCall()?.init?.body))
    expect(forwarded.model).toBe('cloud-standard-model')
    expect(forwarded.model).not.toBe('auto')
  })
})

describe('other text endpoints accept "auto"', () => {
  // AC5 — Responses API.
  test('POST /ai/v1/responses resolves auto', async () => {
    setAutoTierOverrides({ standard: 'gpt-5.4-mini' })
    const res = await postResponses(buildApp(), 'auto')
    expect(res.status).toBe(200)
    expect(upstreamCall()?.url).toBe('https://api.openai.com/v1/responses')
    expect(upstreamBody()?.model).toBe('gpt-5.4-mini')
  })

  // AC5 — Anthropic-native messages.
  test('POST /ai/anthropic/v1/messages resolves auto', async () => {
    const res = await postAnthropic(buildApp(), 'auto')
    expect(res.status).toBe(200)
    expect(upstreamCall()?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(upstreamBody()?.model).toBe(AUTO_STANDARD_DEFAULT)
  })
})
