// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-416 acceptance — AC #2.
 *
 * A `shogo_sk_` key minted *before* the trust gate must stop working while its
 * user is held, on both proxy surfaces, and must come back once the hold lifts.
 * The 403 has to carry the code (not a generic 401) so the client can show the
 * verify CTA.
 *
 *   bun test apps/api/src/__tests__/qa-sho416-proxy-hold.acceptance.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.OPENAI_API_KEY = 'sk-openai-test'

// ─── The account under test ───────────────────────────────────────────────
// `held` flips the assessment row between tests; everything else is fixed.
let held = true
let emailVerified = false

const HIGH = { band: 'high', reviewDecision: null, signals: { provider: 'credential' } }
const LOW = { band: 'low', reviewDecision: null, signals: { provider: 'credential' } }

let wallet: any

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: { findFirst: async () => null, findUnique: async () => null },
    workspace: { findUnique: async () => ({ parentWorkspaceId: null, kind: 'team' }) },
    apiKey: {
      findUnique: async ({ where }: any) =>
        where.keyHash
          ? {
              id: 'apikey_1',
              workspaceId: 'ws-cloud',
              userId: 'user-cloud',
              kind: 'device',
              deviceId: 'device-1',
              revokedAt: null,
              expiresAt: null,
            }
          : null,
      update: async () => ({}),
    },
    // The trust gate's two reads.
    signupRiskAssessment: {
      // SHO-459: banned-linked count resolves linked ids first.
      findMany: async () => [],
      findUnique: async () => (held ? HIGH : LOW),
    },
    user: {
      findUnique: async () => ({ emailVerified }),
    },
    member: {
      findFirst: async () => null,
    },
    usageEvent: { create: async ({ data }: any) => data },
    usageWallet: {
      findUnique: async ({ where }: any) => (where.workspaceId === 'ws-cloud' ? wallet : null),
      create: async ({ data }: any) => (wallet = { ...wallet, ...data }),
      update: async ({ data }: any) => (wallet = { ...wallet, ...data }),
      updateMany: async () => ({ count: 1 }),
      upsert: async ({ create }: any) => (wallet = { ...wallet, ...create }),
    },
    subscription: {
      findFirst: async ({ where }: any) =>
        where.workspaceId === 'ws-cloud'
          ? { id: 'sub_1', workspaceId: 'ws-cloud', status: 'active', planId: 'pro', seats: 1, stripeCustomerId: 'cus_cloud' }
          : null,
    },
    workspaceGrant: { findMany: async () => [] },
    $transaction: async (fn: any) =>
      fn({
        workspace: { findUnique: async () => ({ kind: 'team', parentWorkspaceId: null }) },
        member: { findFirst: async () => null },
        usageWallet: {
          findUnique: async ({ where }: any) => (where.workspaceId === 'ws-cloud' ? wallet : null),
          update: async ({ data }: any) => (wallet = { ...wallet, ...data }),
          create: async ({ data }: any) => (wallet = { ...wallet, ...data }),
          upsert: async ({ create }: any) => (wallet = { ...wallet, ...create }),
        },
        usageEvent: { create: async ({ data }: any) => data },
        subscription: {
          findFirst: async ({ where }: any) =>
            where.workspaceId === 'ws-cloud'
              ? { planId: 'pro', seats: 1, stripeCustomerId: 'cus_cloud' }
              : null,
        },
      }),
  },
}))

class MockStripe {
  constructor(public key: string) {}
  invoiceItems = { create: async (a: any) => ({ id: 'ii_x', ...a }) }
  invoices = { create: async (a: any) => ({ id: 'in_x', ...a }), finalizeInvoice: async (id: string) => ({ id }), pay: async (id: string) => ({ id }) }
  subscriptions = { retrieve: async () => ({ items: { data: [] } }) }
  subscriptionItems = { create: async (a: any) => ({ id: 'si_x', ...a }), update: async (id: string, a: any) => ({ id, ...a }) }
  billing = { meterEvents: { create: async () => ({ id: 'me_x' }) } }
}
mock.module('stripe', () => ({ default: MockStripe }))

// ─── Upstream provider stub ───────────────────────────────────────────────
const originalFetch = globalThis.fetch
let upstreamCalls = 0

beforeAll(() => {
  globalThis.fetch = (async (input: any) => {
    upstreamCalls++
    const url = typeof input === 'string' ? input : input.url
    const body = url.includes('/chat/completions')
      ? JSON.stringify({
          id: 'chatcmpl_test',
          object: 'chat.completion',
          model: 'claude-haiku-4-5',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        })
      : JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
  }) as any
})

beforeEach(() => {
  held = true
  emailVerified = false
  upstreamCalls = 0
  wallet = {
    workspaceId: 'ws-cloud',
    monthlyIncludedUsd: 20,
    monthlyIncludedAllocationUsd: 20,
    dailyIncludedUsd: 0.5,
    dailyUsedThisMonthUsd: 0,
    overageEnabled: false,
    overageHardLimitUsd: null,
    overageAccumulatedUsd: 0,
    overageBilledUsd: 0,
    stripeMeteredItemId: null,
    anniversaryDay: 1,
    lastDailyReset: new Date(),
    lastMonthlyReset: new Date(),
  }
})

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { _clearSignupTrustCacheForTests } = await import('../lib/signup-trust')

const TEST_API_KEY = 'shogo_sk_test_held_account'

function app() {
  const a = new Hono()
  a.route('/api', aiProxyRoutes())
  return a
}

function openAiRequest() {
  return new Request('http://localhost/api/ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_API_KEY}` },
    body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
  })
}

function anthropicRequest() {
  return new Request('http://localhost/api/ai/anthropic/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TEST_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
  })
}

describe('SHO-416 AC#2 — a held key stops working on both proxy surfaces', () => {
  test('OpenAI-compatible path: 403 email_verification_required, no upstream call', async () => {
    _clearSignupTrustCacheForTests()
    const res = await app().fetch(openAiRequest())
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('email_verification_required')
    expect(body.error.message).toContain('Verify your email')
    expect(upstreamCalls).toBe(0)
  })

  test('Anthropic path: 403 email_verification_required, no upstream call', async () => {
    _clearSignupTrustCacheForTests()
    const res = await app().fetch(anthropicRequest())
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('email_verification_required')
    expect(upstreamCalls).toBe(0)
  })

  test('verified but still clustered: 403 account_review_required', async () => {
    emailVerified = true
    _clearSignupTrustCacheForTests()
    const res = await app().fetch(anthropicRequest())
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('account_review_required')
    expect(upstreamCalls).toBe(0)
  })

  test('a low-band user’s key still works', async () => {
    held = false
    _clearSignupTrustCacheForTests()
    const res = await app().fetch(anthropicRequest())
    expect(res.status).toBe(200)
    expect(upstreamCalls).toBeGreaterThan(0)
  })

  test('the hold lifts once the account is no longer high-band', async () => {
    _clearSignupTrustCacheForTests()
    expect((await app().fetch(anthropicRequest())).status).toBe(403)

    // Verification re-scored the account below high; the cache is dropped the
    // way `afterEmailVerification` drops it.
    held = false
    emailVerified = true
    _clearSignupTrustCacheForTests()

    expect((await app().fetch(anthropicRequest())).status).toBe(200)
  })
})

globalThis.fetch = originalFetch
