// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance gate for SHO-479 — Gemini thinking tokens must be billed.
 *
 * Google's OpenAI-compatible endpoint reports
 *   { prompt_tokens: 36, completion_tokens: 5, total_tokens: 103 }
 * with the 62 thinking tokens only in `total_tokens`. The card requires the
 * gap to be folded into the billable output count through one shared parser
 * and used at every OpenAI-format billing site.
 *
 * These tests drive the acceptance criteria through the real routes
 * (`/v1/chat/completions` and `/v1/messages` → OpenAI) and the real stream
 * helper, asserting on what `consumeUsage` is actually charged.
 *
 *   bun test apps/api/src/__tests__/qa-sho479-gemini-thinking-billing.acceptance.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.OPENAI_API_KEY = 'sk-openai-test'
process.env.GOOGLE_API_KEY = 'google-test'

// ─── Wallet + subscription mocks (same shape as ai-proxy-billing.test.ts) ──
type Wallet = {
  workspaceId: string
  monthlyIncludedUsd: number
  monthlyIncludedAllocationUsd: number
  dailyIncludedUsd: number
  dailyUsedThisMonthUsd: number
  overageEnabled: boolean
  overageHardLimitUsd: number | null
  overageAccumulatedUsd: number
  overageBilledUsd: number
  stripeMeteredItemId: string | null
  anniversaryDay: number
  lastDailyReset: Date
  lastMonthlyReset: Date
}

let wallet: Wallet
let usageEvents: any[] = []
let consumeCalls: any[] = []

function applyIncrements(target: any, patch: any): any {
  const out: any = { ...target }
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && 'increment' in (v as any)) {
      out[k] = (target?.[k] ?? 0) + (v as any).increment
    } else {
      out[k] = v
    }
  }
  return out
}

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => null,
      findUnique: async () => null,
    },
    workspace: {
      findUnique: async () => ({ parentWorkspaceId: null }),
    },
    apiKey: {
      findUnique: async ({ where }: any) => {
        if (where.keyHash) {
          return {
            id: 'apikey_1',
            workspaceId: 'ws-cloud',
            userId: 'user-cloud',
            kind: 'device',
            deviceId: 'device-1',
            revokedAt: null,
            expiresAt: null,
          }
        }
        return null
      },
      update: async () => ({}),
    },
    usageEvent: {
      create: async ({ data }: any) => {
        usageEvents.push(data)
        return data
      },
    },
    usageWallet: {
      findUnique: async ({ where }: any) => (where.workspaceId === wallet.workspaceId ? wallet : null),
      create: async ({ data }: any) => {
        wallet = { ...wallet, ...data }
        return wallet
      },
      update: async ({ data }: any) => {
        wallet = applyIncrements(wallet, data)
        return wallet
      },
      updateMany: async ({ data }: any) => {
        wallet = applyIncrements(wallet, data)
        return { count: 1 }
      },
      upsert: async ({ create, update }: any) => {
        wallet = wallet.workspaceId ? applyIncrements(wallet, update) : { ...wallet, ...create }
        return wallet
      },
    },
    subscription: {
      findFirst: async ({ where }: any) =>
        where.workspaceId === 'ws-cloud'
          ? {
              id: 'sub_1',
              workspaceId: 'ws-cloud',
              status: 'active',
              planId: 'pro',
              seats: 1,
              stripeSubscriptionId: 'sub_stripe_1',
              stripeCustomerId: 'cus_cloud',
              firstPaidAt: new Date('2026-01-01T00:00:00Z'),
            }
          : null,
    },
    workspaceGrant: {
      findMany: async () => [],
    },
    $transaction: async (fn: any) =>
      fn({
        workspace: {
          findUnique: async () => ({ kind: 'team', parentWorkspaceId: null }),
        },
        member: {
          findFirst: async () => null,
        },
        usageWallet: {
          findUnique: async ({ where }: any) => (where.workspaceId === wallet.workspaceId ? wallet : null),
          update: async ({ data }: any) => {
            wallet = applyIncrements(wallet, data)
            return wallet
          },
          create: async ({ data }: any) => {
            wallet = { ...wallet, ...data }
            return wallet
          },
          upsert: async ({ create, update }: any) => {
            wallet = applyIncrements(wallet, update)
            if (!wallet.workspaceId) wallet = { ...wallet, ...create }
            return wallet
          },
        },
        usageEvent: {
          create: async ({ data }: any) => {
            usageEvents.push(data)
            return data
          },
        },
        subscription: {
          findFirst: async ({ where }: any) =>
            where.workspaceId === 'ws-cloud'
              ? { planId: 'pro', seats: 1, stripeCustomerId: 'cus_cloud', firstPaidAt: new Date('2026-01-01T00:00:00Z') }
              : null,
        },
      }),
  },
}))

class MockStripe {
  constructor(public key: string) {}
  invoiceItems = { create: async (args: any) => ({ id: 'ii_x', ...args }) }
  invoices = {
    create: async (args: any) => ({ id: 'in_1', ...args }),
    finalizeInvoice: async (id: string) => ({ id, status: 'open' }),
    pay: async (id: string) => ({ id, status: 'paid' }),
  }
  subscriptions = { retrieve: async () => ({ items: { data: [] } }) }
  subscriptionItems = { create: async (args: any) => ({ id: 'si_new', ...args }), update: async (id: string, a: any) => ({ id, ...a }) }
  billing = { meterEvents: { create: async () => ({ id: 'me_x' }) } }
}
mock.module('stripe', () => ({ default: MockStripe }))

const realBilling = await import('../services/billing.service')
const originalConsume = realBilling.consumeUsage
mock.module('../services/billing.service', () => ({
  ...realBilling,
  consumeUsage: async (params: any) => {
    consumeCalls.push(params)
    return originalConsume(params)
  },
}))

const originalFetch = globalThis.fetch

beforeEach(() => {
  usageEvents = []
  consumeCalls = []
  globalThis.fetch = originalFetch
  wallet = {
    workspaceId: 'ws-cloud',
    monthlyIncludedUsd: 20,
    monthlyIncludedAllocationUsd: 20,
    dailyIncludedUsd: 0.5,
    dailyUsedThisMonthUsd: 0,
    overageEnabled: true,
    overageHardLimitUsd: null,
    overageAccumulatedUsd: 0,
    overageBilledUsd: 0,
    stripeMeteredItemId: null,
    anniversaryDay: 1,
    lastDailyReset: new Date(),
    lastMonthlyReset: new Date(),
  }
})

beforeAll(() => {
  // keep whatever beforeEach installed; nothing to warm up
})

const { Hono } = await import('hono')
const {
  aiProxyRoutes,
  anthropicUsageToOpenAI,
  proxyOpenAIStream,
  splitOpenAICompletionUsage,
} = await import('../routes/ai-proxy')
const { calculateUsageCost } = await import('../lib/usage-cost')

const TEST_API_KEY = 'shogo_sk_test_sho479_qa'

function sseResponse(frames: string[]) {
  return new Response(frames.join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  }) as any
}

function jsonResponse(body: any) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }) as any
}

// ─── AC 1-3: the shared parser itself ───────────────────────────────────────
describe('SHO-479 AC1-3: splitOpenAICompletionUsage', () => {
  test('AC1: Gemini 36/5/103 → 67 billable output, 62 reasoning', () => {
    expect(splitOpenAICompletionUsage({ prompt_tokens: 36, completion_tokens: 5, total_tokens: 103 }))
      .toEqual({ outputTokens: 67, reasoningTokens: 62 })
  })

  test('AC2: OpenAI reasoning already inside completion_tokens is not double counted', () => {
    expect(splitOpenAICompletionUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 30 },
    })).toEqual({ outputTokens: 50, reasoningTokens: 30 })
  })

  test('AC2: no total / short total / undefined never yields a negative output', () => {
    expect(splitOpenAICompletionUsage({ prompt_tokens: 100, completion_tokens: 50 }))
      .toEqual({ outputTokens: 50, reasoningTokens: 0 })
    expect(splitOpenAICompletionUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 120 }))
      .toEqual({ outputTokens: 50, reasoningTokens: 0 })
    expect(splitOpenAICompletionUsage(undefined)).toEqual({ outputTokens: 0, reasoningTokens: 0 })
  })

  test('AC3: Anthropic cache-write and DeepSeek cache-hit shapes leave no gap', () => {
    expect(splitOpenAICompletionUsage(anthropicUsageToOpenAI(1000, 900, 100, 50)))
      .toEqual({ outputTokens: 50, reasoningTokens: 0 })
    expect(splitOpenAICompletionUsage({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_cache_hit_tokens: 60,
      prompt_cache_miss_tokens: 40,
    })).toEqual({ outputTokens: 40, reasoningTokens: 0 })
  })
})

// ─── AC 4a: the stream path (proxyOpenAIStream → noteUsage → onComplete) ────
describe('SHO-479 AC4a: streaming Gemini bills the thinking tokens', () => {
  test('onComplete receives 36 in / 67 out / 62 reasoning for a Gemini final chunk', async () => {
    globalThis.fetch = (async () => sseResponse([
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}',
      '',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":36,"completion_tokens":5,"total_tokens":103}}',
      '',
      'data: [DONE]',
      '',
    ])) as any

    const completions: number[][] = []
    const res = await proxyOpenAIStream(
      { model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'hi' }] } as any,
      'google-key',
      { provider: 'google', apiModel: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite' } as any,
      (...args: number[]) => completions.push(args),
    )
    await res.text()

    expect(completions).toEqual([[36, 67, 0, 62, 0]])
  })
})

// ─── AC 4b: non-stream /v1/chat/completions (Google provider) ──────────────
describe('SHO-479 AC4b: /v1/chat/completions bills Gemini output = 67', () => {
  test('a google model is charged 36 in / 67 out / 62 reasoning', async () => {
    globalThis.fetch = (async () => jsonResponse({
      id: 'chatcmpl-gemini-1',
      object: 'chat.completion',
      model: 'gemini-3.5-flash-lite',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 36, completion_tokens: 5, total_tokens: 103 },
    })) as any

    const app = new Hono()
    app.route('/api', aiProxyRoutes())

    const res = await app.fetch(new Request('http://localhost/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_API_KEY}` },
      body: JSON.stringify({
        model: 'gemini-3.5-flash-lite',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 80))

    const charged = consumeCalls.find((c) => c.actionType === 'ai_proxy_completion')
    expect(charged).toBeDefined()
    expect(charged.actionMetadata.inputTokens).toBe(36)
    expect(charged.actionMetadata.outputTokens).toBe(67)
    expect(charged.actionMetadata.reasoningTokens).toBe(62)
    expect(charged.billedUsd).toBeCloseTo(
      calculateUsageCost(36, 67, 'gemini-3.5-flash-lite').billedUsd,
      12,
    )
    expect(charged.billedUsd).toBeGreaterThan(
      calculateUsageCost(36, 5, 'gemini-3.5-flash-lite').billedUsd,
    )
  })

  test('OpenAI usage through the same route is unchanged (reasoning stays inside output)', async () => {
    globalThis.fetch = (async () => jsonResponse({
      id: 'chatcmpl-oai-1',
      object: 'chat.completion',
      model: 'gpt-5.4-nano',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: { reasoning_tokens: 30 },
      },
    })) as any

    const app = new Hono()
    app.route('/api', aiProxyRoutes())

    const res = await app.fetch(new Request('http://localhost/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-5.4-nano',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 80))

    const charged = consumeCalls.find((c) => c.actionType === 'ai_proxy_completion')
    expect(charged).toBeDefined()
    expect(charged.actionMetadata.inputTokens).toBe(100)
    expect(charged.actionMetadata.outputTokens).toBe(50)
    expect(charged.actionMetadata.reasoningTokens).toBe(30)
  })
})

// ─── AC 4c: /v1/messages → OpenAI non-stream (previously passed no reasoning) ─
describe('SHO-479 AC4c: /v1/messages→OpenAI uses the same numbers', () => {
  test('the Anthropic-shaped route charges 67 output and 62 reasoning', async () => {
    globalThis.fetch = (async () => jsonResponse({
      id: 'chatcmpl-gemini-2',
      object: 'chat.completion',
      model: 'gpt-5.4-nano',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 36, completion_tokens: 5, total_tokens: 103 },
    })) as any

    const app = new Hono()
    app.route('/api', aiProxyRoutes())

    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TEST_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'gpt-5.4-nano',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 32,
      }),
    }))
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 80))

    const charged = consumeCalls.find((c) => c.actionType === 'ai_proxy_completion')
    expect(charged).toBeDefined()
    expect(charged.actionMetadata.inputTokens).toBe(36)
    expect(charged.actionMetadata.outputTokens).toBe(67)
    // Before the fix this route passed no reasoning at all.
    expect(charged.actionMetadata.reasoningTokens).toBe(62)
  })
})
