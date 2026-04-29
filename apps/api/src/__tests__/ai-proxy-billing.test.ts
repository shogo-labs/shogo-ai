// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy ↔ Billing Integration Tests
 *
 * Pins the cloud-side billing path that fires when a desktop running in
 * local mode (`SHOGO_LOCAL_MODE=true && SHOGO_API_KEY=shogo_sk_…`) forwards
 * agent traffic to the cloud proxy. The local desktop short-circuits its
 * own billing service and `forwardChatCompletionsToCloud`s the request to
 * `studio.shogo.ai`; the cloud proxy is the authority that resolves the
 * API key to a workspace and runs `consumeUsage` + `chargeOverageBlocks`
 * against that workspace's wallet.
 *
 * These tests fake the upstream LLM provider with `mock.module('fetch', …)`
 * style stubs so we exercise the full proxy → billing integration without
 * leaving the process. Local-mode short-circuit is verified separately so
 * future refactors can't accidentally double-bill (once locally, once on
 * cloud) or skip cloud billing entirely.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-billing.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'

// Force cloud-side mode for this test file so the proxy doesn't try to
// forward to itself. `SHOGO_LOCAL_MODE` is read at module load time, which
// is why we use a dedicated test file.
delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.OPENAI_API_KEY = 'sk-openai-test'

// ─── Wallet + subscription mocks ─────────────────────────────────────────
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

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findFirst: async () => null,
      findUnique: async () => null,
    },
    apiKey: {
      findUnique: async ({ where }: any) => {
        // Hashed key lookup — tests pre-stage a hash that resolveApiKey computes.
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
        wallet = wallet.workspaceId
          ? applyIncrements(wallet, update)
          : { ...wallet, ...create }
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
            }
          : null,
    },
    $transaction: async (fn: any) =>
      fn({
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
      }),
  },
  SubscriptionStatus: {},
  BillingInterval: {},
}))

// ─── Stripe mock ─────────────────────────────────────────────────────────
const stripe = {
  invoiceItemCreate: [] as any[],
  invoiceCreate: [] as any[],
}

class MockStripe {
  constructor(public key: string) {}
  invoiceItems = {
    create: async (args: any, opts?: any) => {
      stripe.invoiceItemCreate.push({ ...args, _opts: opts })
      return { id: 'ii_x', ...args }
    },
  }
  invoices = {
    create: async (args: any, opts?: any) => {
      stripe.invoiceCreate.push({ ...args, _opts: opts })
      return { id: `in_${stripe.invoiceCreate.length}`, ...args }
    },
    finalizeInvoice: async (id: string) => ({ id, status: 'open' }),
    pay: async (id: string) => ({ id, status: 'paid' }),
  }
  subscriptions = {
    retrieve: async () => ({ items: { data: [] } }),
  }
  subscriptionItems = {
    create: async (args: any) => ({ id: 'si_new', ...args }),
    update: async (id: string, args: any) => ({ id, ...args }),
  }
  billing = {
    meterEvents: { create: async () => ({ id: 'me_x' }) },
  }
}

mock.module('stripe', () => ({ default: MockStripe }))

// ─── Track consumeUsage to verify the proxy → billing call site ──────────
const realBilling = await import('../services/billing.service')
const originalConsume = realBilling.consumeUsage
mock.module('../services/billing.service', () => ({
  ...realBilling,
  consumeUsage: async (params: any) => {
    consumeCalls.push(params)
    return originalConsume(params)
  },
}))

// ─── Mock upstream LLM provider via global fetch ─────────────────────────
const originalFetch = globalThis.fetch
let upstreamCalls: { url: string; init?: RequestInit }[] = []

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    upstreamCalls.push({ url, init })
    // Anthropic non-streaming JSON shape — minimal but enough for the
    // proxy to extract usage and finish the request.
    const body = JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hello back' }],
      usage: {
        input_tokens: 1234,
        output_tokens: 56,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as any
  }) as any
})

beforeEach(() => {
  upstreamCalls = []
  usageEvents = []
  consumeCalls = []
  stripe.invoiceItemCreate = []
  stripe.invoiceCreate = []
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

// ─── Imports AFTER mocks ─────────────────────────────────────────────────
const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')

// We need a real shogo_sk_ key whose hash matches what `resolveApiKey`
// computes. The api-keys mock above always returns ws-cloud, so any key
// that starts with `shogo_sk_` works.
const TEST_API_KEY = 'shogo_sk_test_cloud_billing'

describe('AI proxy → billing (cloud-side, shogo_sk_ auth)', () => {
  test('Anthropic forwarded request bills the API key\'s cloud workspace', async () => {
    const app = new Hono()
    app.route('/api', aiProxyRoutes())

    const req = new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TEST_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 32,
      }),
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(200)

    // Upstream Anthropic API was hit (proves we did NOT short-circuit on
    // local mode and DID forward to the provider after billing pre-check).
    expect(upstreamCalls.length).toBeGreaterThan(0)

    // Allow fire-and-forget recordUsage to flush.
    await new Promise((r) => setTimeout(r, 30))

    // The billing call must target the API key's resolved workspace, not
    // some sentinel — this is the link that broke historically when
    // local-mode flags leaked across the trust boundary.
    expect(consumeCalls.length).toBeGreaterThan(0)
    const charged = consumeCalls.find((c) => c.workspaceId === 'ws-cloud')
    expect(charged).toBeDefined()
    expect(charged.projectId).toBeNull() // 'api-key' sentinel → null FK
    expect(charged.memberId).toBe('user-cloud')
    expect(charged.actionType).toBe('ai_proxy_completion')
    expect(charged.billedUsd).toBeGreaterThan(0)
  })

  test('overage caused by a forwarded request triggers a $100 trust block on the cloud workspace', async () => {
    // Wallet set up so this single request will blow past included usage
    // and accrue >$100 of overage in one shot — proves the new escalating
    // ladder fires on the cloud side without any client-side trigger.
    wallet = {
      ...wallet,
      monthlyIncludedUsd: 0,
      dailyIncludedUsd: 0,
      monthlyIncludedAllocationUsd: 0,
      overageEnabled: true,
      overageHardLimitUsd: null,
    }
    // Pump the usage so a single accounting hop trips a block.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'msg_big',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'x' }],
          // ~50M input tokens on the cheapest billable model still pushes
          // billedUsd past $100 with the 20% markup.
          usage: {
            input_tokens: 100_000_000,
            output_tokens: 100_000_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as any) as any

    const app = new Hono()
    app.route('/api', aiProxyRoutes())

    const res = await app.fetch(
      new Request('http://localhost/api/ai/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 32,
        }),
      }),
    )
    expect(res.status).toBe(200)

    // Allow recordUsage + chargeOverageBlocks fire-and-forget chains.
    await new Promise((r) => setTimeout(r, 60))

    // The cloud workspace was billed and a trust block invoice fired.
    expect(consumeCalls.find((c) => c.workspaceId === 'ws-cloud')).toBeDefined()
    expect(stripe.invoiceItemCreate.length).toBeGreaterThan(0)
    expect(stripe.invoiceItemCreate[0].amount).toBeGreaterThanOrEqual(100 * 100)
    expect(stripe.invoiceCreate.length).toBeGreaterThan(0)
  })
})

// Reset fetch so we don't leak the stub into other test files.
globalThis.fetch = originalFetch
