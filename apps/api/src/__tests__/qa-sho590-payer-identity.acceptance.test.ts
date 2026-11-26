// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-590 AC2, QA acceptance — attribution may never move the payer.
 *
 * The card's decision is "only attribution changes, who pays does not": the
 * wallet and the seat of a forwarded desktop call must be exactly the ones it
 * has today, which is `resolveBillingWorkspaceId(hostedWorkspace)` — today's
 * `resolveBillingWorkspaceId` hop from the hosted workspace to the workspace
 * that registered the machine, and only while that hop is allowed (SEC-29:
 * the machine's user is an owner or billing admin there).
 *
 * The plan's acceptance conditions for the hint (hosted, instance bound to the
 * key's workspace and user, membership, project in workspace) do NOT include the
 * SEC-29 payer role, so the hint is legitimately accepted for a machine whose
 * user is a plain member of the paying workspace or was demoted from owner after
 * pairing. On that path `resolveBillingWorkspaceId(hostedWorkspace)` returns the
 * hosted workspace itself, so if `recordUsage` lets the wallet follow the
 * attribution the debit moves off the paying workspace onto the hosted
 * workspace's own (unpaid) wallet: the payer is no longer charged and the row
 * the card wants in the hosted workspace's Analytics is written against a plan
 * that cannot afford it. AC2 says the wallet is identical for every accepted
 * hint — attribution moves, who pays does not.
 *
 * This file pins that invariant on the one case the feature's own tests leave
 * out: a proven host whose user is a plain member of the paying workspace.
 *
 *   bun test apps/api/src/__tests__/qa-sho590-payer-identity.acceptance.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'

const KEY_WORKSPACE = 'ws-key-owner'
const HOSTED_WORKSPACE = 'ws-hosted'
const HOST_INSTANCE = 'inst-macbook'
const KEY_USER = 'user-owner'
const SENDER = 'user-sender'
const HOSTED_PROJECT = 'proj-hosted'
const FIRST_PAID_AT = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)


const keyFacts = { workspaceId: KEY_WORKSPACE, userId: KEY_USER, kind: 'device' }
const instance = { workspaceId: KEY_WORKSPACE, userId: KEY_USER }
const members = new Set<string>([
  `${KEY_WORKSPACE}:${KEY_USER}`,
  `${HOSTED_WORKSPACE}:${KEY_USER}`,
  `${HOSTED_WORKSPACE}:${SENDER}`,
])
const projects: Record<string, { workspaceId: string }> = {
  [HOSTED_PROJECT]: { workspaceId: HOSTED_WORKSPACE },
}

/**
 * The machine user's role in the *paying* workspace, which is what SEC-29 reads
 * before it lets a hosted workspace borrow that plan and wallet.
 */
let payerRole = 'owner'
let payerIsBillingAdmin = false

let usageEvents: any[] = []
let walletTargets: string[] = []
let wallet: any

function applyIncrements(target: any, patch: any): any {
  const out: any = { ...target }
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && 'increment' in (v as any)) {
      out[k] = (target?.[k] ?? 0) + (v as any).increment
    } else if (v && typeof v === 'object' && 'decrement' in (v as any)) {
      out[k] = (target?.[k] ?? 0) - (v as any).decrement
    } else {
      out[k] = v
    }
  }
  return out
}

function walletFor(workspaceId: string) {
  walletTargets.push(workspaceId)
  return wallet && wallet.workspaceId === workspaceId ? wallet : null
}

const usageWalletMock = {
  findUnique: async ({ where }: any) => walletFor(where.workspaceId),
  create: async ({ data }: any) => {
    wallet = { ...wallet, ...data }
    return wallet
  },
  update: async ({ where, data }: any) => {
    walletTargets.push(where.workspaceId)
    wallet = applyIncrements(wallet, data)
    return wallet
  },
  updateMany: async ({ where, data }: any) => {
    walletTargets.push(where.workspaceId)
    wallet = applyIncrements(wallet, data)
    return { count: 1 }
  },
  upsert: async ({ where, create, update }: any) => {
    walletTargets.push(where.workspaceId)
    wallet = wallet?.workspaceId ? applyIncrements(wallet, update) : { ...create }
    return wallet
  },
}

function memberRow(workspaceId: string, userId: string) {
  const paying = workspaceId === KEY_WORKSPACE
  return {
    id: `member-${workspaceId}-${userId}`,
    userId,
    role: paying ? payerRole : 'owner',
    isBillingAdmin: paying ? payerIsBillingAdmin : false,
  }
}

mock.module('../lib/prisma', () =>
  withPrismaExports({
    prisma: {
      apiKey: {
        findUnique: async ({ where }: any) =>
          where.keyHash ? { id: 'apikey_1', ...keyFacts, deviceId: 'device-a', revokedAt: null, expiresAt: null } : null,
        update: async () => ({}),
      },
      workspace: {
        findUnique: async ({ where, select }: any) => {
          if (where.id === HOSTED_WORKSPACE) {
            return select?.hostInstanceId !== undefined
              ? { id: HOSTED_WORKSPACE, hostInstanceId: HOST_INSTANCE }
              : { parentWorkspaceId: null, hostInstanceId: HOST_INSTANCE, kind: 'team', homeRegion: null }
          }
          if (where.id === KEY_WORKSPACE) {
            return select?.hostInstanceId !== undefined
              ? { id: KEY_WORKSPACE, hostInstanceId: null }
              : { parentWorkspaceId: null, hostInstanceId: null, kind: 'team', homeRegion: null }
          }
          return null
        },
      },
      instance: {
        findUnique: async ({ where }: any) => (where.id === HOST_INSTANCE ? instance : null),
      },
      member: {
        findFirst: async ({ where }: any) => {
          const { workspaceId, userId } = where
          if (typeof workspaceId === 'string' && typeof userId === 'string' && members.has(`${workspaceId}:${userId}`)) {
            return memberRow(workspaceId, userId)
          }
          return null
        },
      },
      project: {
        findUnique: async ({ where }: any) => {
          const row = projects[where.id]
          return row ? { id: where.id, workspaceId: row.workspaceId } : null
        },
        findFirst: async () => null,
      },
      usageEvent: {
        create: async ({ data }: any) => {
          usageEvents.push(data)
          return data
        },
      },
      usageWallet: usageWalletMock,
      subscription: {
        findFirst: async ({ where }: any) =>
          where.workspaceId === KEY_WORKSPACE
            ? {
                id: 'sub_1',
                workspaceId: KEY_WORKSPACE,
                status: 'active',
                planId: 'pro',
                seats: 1,
                stripeSubscriptionId: 'sub_stripe_1',
                stripeCustomerId: 'cus_owner',
                firstPaidAt: FIRST_PAID_AT,
              }
            : null,
      },
      workspaceGrant: { findMany: async () => [] },
      $transaction: async (fn: any) =>
        fn({
          workspace: {
            findUnique: async ({ where }: any) => ({ id: where.id, kind: 'team', parentWorkspaceId: null }),
          },
          member: { findFirst: async () => null, update: async () => ({}) },
          usageWallet: usageWalletMock,
          usageEvent: {
            create: async ({ data }: any) => {
              usageEvents.push(data)
              return data
            },
          },
          subscription: {
            findFirst: async ({ where }: any) =>
              where.workspaceId === KEY_WORKSPACE
                ? { planId: 'pro', seats: 1, stripeCustomerId: 'cus_owner', firstPaidAt: FIRST_PAID_AT }
                : null,
          },
        }),
    },
  }),
)

mock.module('stripe', () => ({
  default: class {
    constructor(public key: string) {}
    invoiceItems = { create: async () => ({ id: 'ii_x' }) }
    invoices = { create: async () => ({ id: 'in_x' }), finalizeInvoice: async () => ({}), pay: async () => ({}) }
    subscriptions = { retrieve: async () => ({ items: { data: [] } }) }
    subscriptionItems = { create: async () => ({ id: 'si_x' }), update: async () => ({ id: 'si_x' }) }
    billing = { meterEvents: { create: async () => ({ id: 'me_x' }) } }
  },
}))

const realBilling = await import('../services/billing.service')

const originalFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: 'msg_590',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'hello back' }],
        usage: {
          input_tokens: 1000,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as any
})

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { _resetHostedUsageAttributionCache } = await import('../lib/hosted-usage-attribution')

const TEST_API_KEY = 'shogo_sk_test_payer_identity'

function freshWallet() {
  return {
    workspaceId: KEY_WORKSPACE,
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
    promoCreditUsd: 0,
    promoCreditExpiresAt: null,
    fiveHourWindowStart: null,
    fiveHourUsedUsd: 0,
    weeklyWindowStart: null,
    weeklyUsedUsd: 0,
  }
}

beforeEach(() => {
  usageEvents = []
  walletTargets = []
  wallet = freshWallet()
  payerRole = 'owner'
  payerIsBillingAdmin = false
  _resetHostedUsageAttributionCache()
})

const HOSTED_HINT_HEADERS = {
  'x-shogo-workspace-id': HOSTED_WORKSPACE,
  'x-shogo-project-id': HOSTED_PROJECT,
  'x-shogo-member-id': SENDER,
}

async function postMessage(headers: Record<string, string>) {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  const res = await app.fetch(
    new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TEST_API_KEY,
        'anthropic-version': '2023-06-01',
        ...headers,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 32,
      }),
    }),
  )
  // recordUsage is fire-and-forget on the response path.
  await new Promise((r) => setTimeout(r, 40))
  return res
}

describe('SHO-590 AC2: an accepted hint never moves the wallet', () => {
  test('the payer hop is allowed: attribution is accepted and the paying wallet is debited', async () => {
    // `resolveBillingWorkspaceId` lends the paying plan: owner of the key workspace.
    expect(await realBilling.resolveBillingWorkspaceId(HOSTED_WORKSPACE)).toBe(KEY_WORKSPACE)

    const res = await postMessage({ ...HOSTED_HINT_HEADERS, 'x-chat-session-id': 'chat-590' })
    expect(res.status).toBe(200)

    expect(usageEvents.length).toBe(1)
    expect(usageEvents[0].workspaceId).toBe(HOSTED_WORKSPACE)
    expect(usageEvents[0].projectId).toBe(HOSTED_PROJECT)
    expect([...new Set(walletTargets)]).toEqual([KEY_WORKSPACE])
  })

  test('the payer hop is refused (plain member of the paying workspace): the wallet does not follow the attribution', async () => {
    payerRole = 'member'
    _resetHostedUsageAttributionCache()

    // SEC-29 does not lend this plan out, so the hop yields the hosted
    // workspace itself. The wallet must still be the one today's call debits —
    // the credential's own workspace — while the row is attributed to the
    // hosted workspace, its project and the person who sent the turn.
    expect(await realBilling.resolveBillingWorkspaceId(HOSTED_WORKSPACE)).toBe(HOSTED_WORKSPACE)

    const res = await postMessage({ ...HOSTED_HINT_HEADERS, 'x-chat-session-id': 'chat-590' })
    expect(res.status).toBe(200)

    expect(usageEvents.length).toBe(1)
    expect(usageEvents[0].workspaceId).toBe(HOSTED_WORKSPACE)
    expect(usageEvents[0].projectId).toBe(HOSTED_PROJECT)
    expect(usageEvents[0].memberId).toBe(SENDER)
    // …and not one cent of it leaves the paying workspace.
    expect(walletTargets.length).toBeGreaterThan(0)
    expect([...new Set(walletTargets)]).toEqual([KEY_WORKSPACE])
  })

  test('the payer hop is refused after a demotion: the wallet does not follow the attribution', async () => {
    // Paired as an owner, then demoted to plain member.
    payerRole = 'member'
    payerIsBillingAdmin = false
    _resetHostedUsageAttributionCache()

    expect(await realBilling.resolveBillingWorkspaceId(HOSTED_WORKSPACE)).toBe(HOSTED_WORKSPACE)

    const res = await postMessage(HOSTED_HINT_HEADERS)
    expect(res.status).toBe(200)
    expect(usageEvents[0].workspaceId).toBe(HOSTED_WORKSPACE)
    expect([...new Set(walletTargets)]).toEqual([KEY_WORKSPACE])
  })
})

// Leave the process as we found it for the next test file.
globalThis.fetch = originalFetch
