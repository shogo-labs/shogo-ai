// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-590 §A — a paired desktop's forwarded call is metered to the hosted
 * workspace it ran in, and to nobody else.
 *
 * A desktop signs in to Shogo Cloud and gets a device key scoped to the paying
 * workspace. It runs a hosted workspace's agent turn on its own machine and
 * forwards the model call with that key, so without a hint the cloud records the
 * spend on the paying workspace with `projectId: null`, no chat and no person —
 * the hosted workspace's Analytics reads nothing and the paying workspace shows
 * everyone's desktop spend as "no project".
 *
 * The desktop now names the workspace, project and person it acted for. This
 * file pins the two halves of the bargain:
 *   • the ledger row lands on the hosted workspace, its project, its chat and the
 *     person who sent the turn (AC1);
 *   • the wallet, the seat and the billing workspace are exactly today's (AC2) —
 *     attribution moved, the payer did not;
 *   • every hint the key cannot prove is ignored, and the call records as it did
 *     before (AC3).
 *
 *   bun test apps/api/src/__tests__/ai-proxy-hosted-usage-attribution.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// Cloud-side mode: the proxy must not try to forward to itself.
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


/** What the key resolves to; the spoof cases change `kind`. */
let keyFacts: { workspaceId: string; userId: string; kind: string } = {
  workspaceId: KEY_WORKSPACE,
  userId: KEY_USER,
  kind: 'device',
}
/** The hosted workspace's `hostInstanceId`; `null` = not hosted. */
let hostInstanceId: string | null = HOST_INSTANCE
/** The registry row the hosted workspace points at. */
let instance: { workspaceId: string; userId: string } | null = {
  workspaceId: KEY_WORKSPACE,
  userId: KEY_USER,
}
/** Workspace-scoped member rows, keyed `${workspaceId}:${userId}`. */
let members = new Set<string>([
  // The key's owner sits in both: the payer (they own the workspace that
  // registered the machine) and the hosted workspace (SEC-29 membership).
  `${KEY_WORKSPACE}:${KEY_USER}`,
  `${HOSTED_WORKSPACE}:${KEY_USER}`,
  `${HOSTED_WORKSPACE}:${SENDER}`,
])
/** Projects by id. */
let projects: Record<string, { workspaceId: string }> = {
  [HOSTED_PROJECT]: { workspaceId: HOSTED_WORKSPACE },
}

let usageEvents: any[] = []
let consumeCalls: any[] = []
/** Every `where` the wallet was read or written with — the payer proof. */
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

mock.module('../lib/prisma', () =>
  withPrismaExports({
    prisma: {
      apiKey: {
        findUnique: async ({ where }: any) => (where.keyHash ? { id: 'apikey_1', ...keyFacts, deviceId: 'device-a', revokedAt: null, expiresAt: null } : null),
        update: async () => ({}),
      },
      workspace: {
        findUnique: async ({ where, select }: any) => {
          if (where.id === HOSTED_WORKSPACE) {
            return select?.hostInstanceId !== undefined
              ? { id: HOSTED_WORKSPACE, hostInstanceId }
              : { parentWorkspaceId: null, hostInstanceId, kind: 'team', homeRegion: null }
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
        findUnique: async ({ where }: any) =>
          instance && where.id === HOST_INSTANCE ? instance : null,
      },
      member: {
        findFirst: async ({ where }: any) => {
          const workspaceId = where.workspaceId
          const userId = where.userId
          if (typeof workspaceId === 'string' && typeof userId === 'string' && members.has(`${workspaceId}:${userId}`)) {
            return { id: `member-${workspaceId}-${userId}`, userId, role: 'owner' }
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
            findUnique: async ({ where }: any) => ({
              id: where.id,
              kind: 'team',
              parentWorkspaceId: null,
            }),
          },
          // No seat behind the debits in this file: the meter falls back to the
          // pooled allowance, which is what `findFirst` returning null means.
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

// Capture what the proxy asks billing to do, then run the real path so the
// UsageEvent is written through the mocked prisma above.
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
const { aiProxyRoutes, resolveUsageAttribution } = await import('../routes/ai-proxy')
const { _resetHostedUsageAttributionCache } = await import('../lib/hosted-usage-attribution')

const TEST_API_KEY = 'shogo_sk_test_hosted_attribution'

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
  consumeCalls = []
  walletTargets = []
  wallet = freshWallet()
  keyFacts = { workspaceId: KEY_WORKSPACE, userId: KEY_USER, kind: 'device' }
  hostInstanceId = HOST_INSTANCE
  instance = { workspaceId: KEY_WORKSPACE, userId: KEY_USER }
  members = new Set([
    `${KEY_WORKSPACE}:${KEY_USER}`,
    `${HOSTED_WORKSPACE}:${KEY_USER}`,
    `${HOSTED_WORKSPACE}:${SENDER}`,
  ])
  projects = { [HOSTED_PROJECT]: { workspaceId: HOSTED_WORKSPACE } }
  // The attribution proof is memoised per key+hints; a test that flips the
  // fixture must not read its predecessor's answer.
  _resetHostedUsageAttributionCache()
})

const HOSTED_HINT_HEADERS = {
  'x-shogo-workspace-id': HOSTED_WORKSPACE,
  'x-shogo-project-id': HOSTED_PROJECT,
  'x-shogo-member-id': SENDER,
}

/** One proxied Anthropic call, the same shape the desktop forwards. */
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

describe('SHO-590 §A: a forwarded desktop call is metered to the hosted workspace', () => {
  test('AC1: the ledger row carries the hosted workspace, project, person and chat', async () => {
    const res = await postMessage({ ...HOSTED_HINT_HEADERS, 'x-chat-session-id': 'chat-590' })
    expect(res.status).toBe(200)

    expect(usageEvents.length).toBe(1)
    const row = usageEvents[0]
    expect(row.workspaceId).toBe(HOSTED_WORKSPACE)
    expect(row.projectId).toBe(HOSTED_PROJECT)
    expect(row.memberId).toBe(SENDER)
    expect(row.actionType).toBe('ai_proxy_completion')
    expect(row.actionMetadata.chatSessionId).toBe('chat-590')
    // Nothing lands on the key's workspace any more.
    expect(usageEvents.some((event) => event.workspaceId === KEY_WORKSPACE)).toBe(false)
  })

  test('AC2: the wallet, the seat and the billing workspace are exactly today\'s', async () => {
    const res = await postMessage({ ...HOSTED_HINT_HEADERS, 'x-chat-session-id': 'chat-590' })
    expect(res.status).toBe(200)

    const charged = consumeCalls.at(-1)!
    // Attribution names the hosted workspace…
    expect(charged.workspaceId).toBe(HOSTED_WORKSPACE)
    expect(charged.projectId).toBe(HOSTED_PROJECT)
    // …but the seat behind the debit is the device key's holder, not the sender.
    expect(charged.memberId).toBe(SENDER)
    expect(charged.seatMemberId).toBe(KEY_USER)
    // And the money came out of the paying workspace's wallet — every read and
    // write of that wallet targeted the key's workspace, never the hosted one.
    expect(walletTargets.length).toBeGreaterThan(0)
    expect([...new Set(walletTargets)]).toEqual([KEY_WORKSPACE])
  })

  test('AC2: the billing workspace is what `resolveBillingWorkspaceId` already yields', async () => {
    const { resolveBillingWorkspaceId, getEffectivePlanId } = realBilling
    expect(await resolveBillingWorkspaceId(HOSTED_WORKSPACE)).toBe(KEY_WORKSPACE)
    // …and the hosted workspace keeps the payer's plan, so the Analytics panels
    // are not gated as Free.
    expect(await getEffectivePlanId(HOSTED_WORKSPACE)).toBe(await getEffectivePlanId(KEY_WORKSPACE))
  })

  test('no hints records exactly as before: the key\'s workspace, no project, the key owner', async () => {
    const res = await postMessage({})
    expect(res.status).toBe(200)

    const row = usageEvents[0]
    expect(row.workspaceId).toBe(KEY_WORKSPACE)
    expect(row.projectId).toBeNull()
    expect(row.memberId).toBe(KEY_USER)
    // No `seatMemberId` is passed at all when the two members agree.
    expect(consumeCalls.at(-1)!.seatMemberId).toBeUndefined()
  })
})

describe('SHO-590 AC3: a hint the key cannot prove is ignored', () => {
  test('a workspace that machine does not host', async () => {
    hostInstanceId = null
    const res = await postMessage(HOSTED_HINT_HEADERS)
    expect(res.status).toBe(200)
    expect(usageEvents[0].workspaceId).toBe(KEY_WORKSPACE)
    expect(usageEvents[0].projectId).toBeNull()
  })

  test('a workspace hosted by another machine in a different workspace', async () => {
    instance = { workspaceId: 'ws-someone-else', userId: KEY_USER }
    const res = await postMessage(HOSTED_HINT_HEADERS)
    expect(res.status).toBe(200)
    expect(usageEvents[0].workspaceId).toBe(KEY_WORKSPACE)
    expect(usageEvents[0].projectId).toBeNull()
  })

  test('a workspace hosted by another user\'s machine', async () => {
    instance = { workspaceId: KEY_WORKSPACE, userId: 'user-other' }
    const res = await postMessage(HOSTED_HINT_HEADERS)
    expect(res.status).toBe(200)
    expect(usageEvents[0].workspaceId).toBe(KEY_WORKSPACE)
  })

  test('a project that belongs to another workspace', async () => {
    projects[HOSTED_PROJECT] = { workspaceId: 'ws-elsewhere' }
    const res = await postMessage(HOSTED_HINT_HEADERS)
    expect(res.status).toBe(200)
    expect(usageEvents[0].workspaceId).toBe(KEY_WORKSPACE)
    expect(usageEvents[0].projectId).toBeNull()
  })

  test('a project that does not exist', async () => {
    delete projects[HOSTED_PROJECT]
    const res = await postMessage(HOSTED_HINT_HEADERS)
    expect(res.status).toBe(200)
    expect(usageEvents[0].workspaceId).toBe(KEY_WORKSPACE)
  })

  test('a person who is not a member of the hosted workspace', async () => {
    members.delete(`${HOSTED_WORKSPACE}:${SENDER}`)
    const res = await postMessage(HOSTED_HINT_HEADERS)
    expect(res.status).toBe(200)
    expect(usageEvents[0].workspaceId).toBe(KEY_WORKSPACE)
  })

  test('a key whose user is no longer a member of the hosted workspace', async () => {
    members.delete(`${HOSTED_WORKSPACE}:${KEY_USER}`)
    const res = await postMessage(HOSTED_HINT_HEADERS)
    expect(res.status).toBe(200)
    expect(usageEvents[0].workspaceId).toBe(KEY_WORKSPACE)
    expect(usageEvents[0].projectId).toBeNull()
  })

  test('a non-device (user) key', async () => {
    keyFacts = { workspaceId: KEY_WORKSPACE, userId: KEY_USER, kind: 'user' }
    const res = await postMessage(HOSTED_HINT_HEADERS)
    expect(res.status).toBe(200)
    expect(usageEvents[0].workspaceId).toBe(KEY_WORKSPACE)
    expect(usageEvents[0].projectId).toBeNull()
  })
})

// A payload with no proof recorded — every caller but a paired desktop.
describe('SHO-590: without proof the ledger row is the credential\'s own scope', () => {
  const base = {
    workspaceId: KEY_WORKSPACE,
    userId: KEY_USER,
    type: 'ai-proxy' as const,
    iat: 0,
    exp: 0,
  }

  test('a project token keeps its project', () => {
    expect(resolveUsageAttribution({ ...base, projectId: HOSTED_PROJECT })).toEqual({
      workspaceId: KEY_WORKSPACE,
      projectId: HOSTED_PROJECT,
    })
  })

  test('a sentinel project is not a project', () => {
    for (const sentinel of ['api-key', 'workspace', 'system']) {
      expect(resolveUsageAttribution({ ...base, projectId: sentinel })).toEqual({
        workspaceId: KEY_WORKSPACE,
        projectId: null,
      })
    }
  })

  test('proven attribution wins, and a sentinel attributed project is still not one', () => {
    // `payerWorkspaceId` is the credential's own workspace — the payer today —
    // so the wallet never follows the attribution (AC2).
    expect(resolveUsageAttribution({ ...base, projectId: 'api-key', usageWorkspaceId: HOSTED_WORKSPACE, usageProjectId: HOSTED_PROJECT })).toEqual({
      workspaceId: HOSTED_WORKSPACE,
      projectId: HOSTED_PROJECT,
      payerWorkspaceId: KEY_WORKSPACE,
    })
    expect(resolveUsageAttribution({ ...base, projectId: 'api-key', usageWorkspaceId: HOSTED_WORKSPACE, usageProjectId: 'workspace' })).toEqual({
      workspaceId: HOSTED_WORKSPACE,
      projectId: null,
      payerWorkspaceId: KEY_WORKSPACE,
    })
  })
})

// Leave the process as we found it for the next test file.
globalThis.fetch = originalFetch
