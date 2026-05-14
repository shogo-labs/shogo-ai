// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

interface BillingState {
  syncCalls: any[]
  upsertCalls: any[]
  allocCalls: any[]
  syncReturn: any
  walletReturn: any
  subscriptionReturn: any
  walletStateReturn: any
  syncThrow: Error | null
}

const bs: BillingState = {
  syncCalls: [],
  upsertCalls: [],
  allocCalls: [],
  syncReturn: { id: 'sub-1', planId: 'pro' },
  walletReturn: { workspaceId: 'ws-1', includedUsd: 20 },
  subscriptionReturn: null,
  walletStateReturn: null,
  syncThrow: null,
}

mock.module('../../services/billing.service', () => ({
  syncFromStripe: async (args: any) => {
    bs.syncCalls.push(args)
    if (bs.syncThrow) throw bs.syncThrow
    return bs.syncReturn
  },
  upsertBillingAccount: async (workspaceId: string, data: any) => {
    bs.upsertCalls.push({ workspaceId, data })
  },
  allocateMonthlyIncluded: async (workspaceId: string, planId: string, seats: number) => {
    bs.allocCalls.push({ workspaceId, planId, seats })
    return bs.walletReturn
  },
  getSubscription: async (_workspaceId: string) => bs.subscriptionReturn,
  getUsageWallet: async (_workspaceId: string) => bs.walletStateReturn,
}))

let userFindImpl: (args: any) => Promise<any | null> = async () => null

mock.module('../../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: async (args: any) => userFindImpl(args),
    },
  },
  SubscriptionStatus: { active: 'active', canceled: 'canceled' },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

const app = (await import('../internal-e2e')).default

const origEnv = {
  NODE_ENV: process.env.NODE_ENV,
  SHOGO_E2E_BOOTSTRAP_ENABLED: process.env.SHOGO_E2E_BOOTSTRAP_ENABLED,
  SHOGO_E2E_BOOTSTRAP_SECRET: process.env.SHOGO_E2E_BOOTSTRAP_SECRET,
}

function setEnv(over: Partial<typeof origEnv>) {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete (process.env as any)[k]
    else (process.env as any)[k] = v
  }
}

beforeEach(() => {
  bs.syncCalls = []
  bs.upsertCalls = []
  bs.allocCalls = []
  bs.syncReturn = { id: 'sub-1', planId: 'pro' }
  bs.walletReturn = { workspaceId: 'ws-1', includedUsd: 20 }
  bs.subscriptionReturn = null
  bs.walletStateReturn = null
  bs.syncThrow = null
  userFindImpl = async () => null
  setEnv({ NODE_ENV: 'test', SHOGO_E2E_BOOTSTRAP_SECRET: 'test-secret' })
  delete process.env.SHOGO_E2E_BOOTSTRAP_ENABLED
})

afterEach(() => {
  setEnv(origEnv)
})

function jsonReq(path: string, body: any, opts: { secret?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.secret !== undefined) headers['x-e2e-bootstrap-secret'] = opts.secret
  return new Request(`http://x${path}`, {
    method: opts.method ?? 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  })
}

describe('POST /bootstrap-subscription — gating', () => {
  it('returns 503 when in production and no override flag', async () => {
    setEnv({ NODE_ENV: 'production', SHOGO_E2E_BOOTSTRAP_ENABLED: undefined })
    const res = await app.fetch(jsonReq('/bootstrap-subscription', {}, { secret: 'test-secret' }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('e2e_bootstrap_disabled')
  })

  it('is enabled in production when SHOGO_E2E_BOOTSTRAP_ENABLED=1', async () => {
    setEnv({ NODE_ENV: 'production', SHOGO_E2E_BOOTSTRAP_ENABLED: '1' })
    const res = await app.fetch(
      jsonReq('/bootstrap-subscription', { workspaceId: 'ws-1', planId: 'pro' }, { secret: 'test-secret' }),
    )
    expect(res.status).toBe(200)
  })

  it('returns 401 when secret header is missing', async () => {
    const res = await app.fetch(jsonReq('/bootstrap-subscription', { workspaceId: 'ws-1' }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('unauthorized')
  })

  it('returns 401 when secret header is wrong', async () => {
    const res = await app.fetch(
      jsonReq('/bootstrap-subscription', { workspaceId: 'ws-1' }, { secret: 'wrong' }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 when SHOGO_E2E_BOOTSTRAP_SECRET is unset (closes the back door)', async () => {
    setEnv({ SHOGO_E2E_BOOTSTRAP_SECRET: undefined })
    const res = await app.fetch(
      jsonReq('/bootstrap-subscription', { workspaceId: 'ws-1' }, { secret: 'anything' }),
    )
    expect(res.status).toBe(401)
  })
})

describe('POST /bootstrap-subscription — validation', () => {
  it('returns 400 on malformed JSON', async () => {
    const res = await app.fetch(
      jsonReq('/bootstrap-subscription', 'not-json{', { secret: 'test-secret' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_json')
  })

  it('returns 400 for an unknown planId', async () => {
    const res = await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { workspaceId: 'ws-1', planId: 'platinum' },
        { secret: 'test-secret' },
      ),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_planId')
    expect(body.allowed.sort()).toEqual(['basic', 'business', 'pro'])
  })

  it('returns 400 when both workspaceId and userEmail are missing', async () => {
    const res = await app.fetch(
      jsonReq('/bootstrap-subscription', { planId: 'pro' }, { secret: 'test-secret' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('workspaceId_or_userEmail_required')
  })

  it('returns 400 when userEmail is not in the e2e-*@mailnull.com shape', async () => {
    const res = await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { userEmail: 'attacker@gmail.com', planId: 'pro' },
        { secret: 'test-secret' },
      ),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('userEmail_must_be_e2e_address')
  })

  it('rejects e2e-prefixed emails on a different domain', async () => {
    const res = await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { userEmail: 'e2e-foo@evil.com', planId: 'pro' },
        { secret: 'test-secret' },
      ),
    )
    expect(res.status).toBe(400)
  })

  it('rejects mailnull-suffixed emails that do not start with e2e-', async () => {
    const res = await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { userEmail: 'admin@mailnull.com', planId: 'pro' },
        { secret: 'test-secret' },
      ),
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when the e2e user has no workspace membership', async () => {
    userFindImpl = async () => ({ members: [] })
    const res = await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { userEmail: 'e2e-x@mailnull.com', planId: 'pro' },
        { secret: 'test-secret' },
      ),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('workspace_not_found_for_user')
    expect(body.email).toBe('e2e-x@mailnull.com')
  })

  it('returns 404 when the e2e user does not exist at all', async () => {
    userFindImpl = async () => null
    const res = await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { userEmail: 'e2e-x@mailnull.com', planId: 'pro' },
        { secret: 'test-secret' },
      ),
    )
    expect(res.status).toBe(404)
  })

  it('lowercases userEmail before comparison', async () => {
    userFindImpl = async (args) => {
      expect(args.where.email).toBe('e2e-x@mailnull.com')
      return { members: [{ workspaceId: 'ws-from-user' }] }
    }
    const res = await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { userEmail: 'E2E-X@MailNull.COM', planId: 'pro' },
        { secret: 'test-secret' },
      ),
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /bootstrap-subscription — happy path', () => {
  it('upserts billing account, syncs subscription, allocates wallet, returns ok', async () => {
    const res = await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { workspaceId: 'ws-1', planId: 'pro', seats: 3, billingInterval: 'annual' },
        { secret: 'test-secret' },
      ),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.workspaceId).toBe('ws-1')

    expect(bs.upsertCalls).toHaveLength(1)
    expect(bs.upsertCalls[0].data.stripeCustomerId).toBe('e2e_bootstrap_cus_ws-1')

    expect(bs.syncCalls).toHaveLength(1)
    const sync = bs.syncCalls[0]
    expect(sync.planId).toBe('pro')
    expect(sync.seats).toBe(3)
    expect(sync.billingInterval).toBe('annual')
    expect(sync.status).toBe('active')
    expect(sync.cancelAtPeriodEnd).toBe(false)
    expect(sync.stripeSubscriptionId).toMatch(/^e2e_bootstrap_sub_ws-1_\d+$/)

    expect(bs.allocCalls).toEqual([{ workspaceId: 'ws-1', planId: 'pro', seats: 3 }])
  })

  it("defaults planId='pro', seats=1, interval='monthly', period=30d", async () => {
    const before = Date.now()
    const res = await app.fetch(
      jsonReq('/bootstrap-subscription', { workspaceId: 'ws-1' }, { secret: 'test-secret' }),
    )
    const after = Date.now()
    expect(res.status).toBe(200)
    expect(bs.syncCalls[0].planId).toBe('pro')
    expect(bs.syncCalls[0].seats).toBe(1)
    expect(bs.syncCalls[0].billingInterval).toBe('monthly')
    const start = (bs.syncCalls[0].currentPeriodStart as Date).getTime()
    const end = (bs.syncCalls[0].currentPeriodEnd as Date).getTime()
    expect(start).toBeGreaterThanOrEqual(before)
    expect(start).toBeLessThanOrEqual(after + 10)
    expect(end - start).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('clamps seats to a positive integer (min 1)', async () => {
    await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { workspaceId: 'ws-1', seats: -5, planId: 'pro' },
        { secret: 'test-secret' },
      ),
    )
    expect(bs.syncCalls[0].seats).toBe(1)
  })

  it('floors fractional seats', async () => {
    await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { workspaceId: 'ws-1', seats: 3.9, planId: 'pro' },
        { secret: 'test-secret' },
      ),
    )
    expect(bs.syncCalls[0].seats).toBe(3)
  })

  it('clamps daysUntilPeriodEnd to [1, 365]', async () => {
    await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { workspaceId: 'ws-1', daysUntilPeriodEnd: 99999, planId: 'pro' },
        { secret: 'test-secret' },
      ),
    )
    const start = (bs.syncCalls[0].currentPeriodStart as Date).getTime()
    const end = (bs.syncCalls[0].currentPeriodEnd as Date).getTime()
    expect((end - start) / (24 * 60 * 60 * 1000)).toBe(365)
    bs.syncCalls = []
    await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { workspaceId: 'ws-1', daysUntilPeriodEnd: -1, planId: 'pro' },
        { secret: 'test-secret' },
      ),
    )
    const start2 = (bs.syncCalls[0].currentPeriodStart as Date).getTime()
    const end2 = (bs.syncCalls[0].currentPeriodEnd as Date).getTime()
    expect((end2 - start2) / (24 * 60 * 60 * 1000)).toBe(1)
  })

  it('falls back to monthly when billingInterval is invalid', async () => {
    await app.fetch(
      jsonReq(
        '/bootstrap-subscription',
        { workspaceId: 'ws-1', billingInterval: 'weekly', planId: 'pro' },
        { secret: 'test-secret' },
      ),
    )
    expect(bs.syncCalls[0].billingInterval).toBe('monthly')
  })

  it('namespaces subscription ID with e2e_bootstrap_ prefix', async () => {
    await app.fetch(
      jsonReq('/bootstrap-subscription', { workspaceId: 'ws-XX', planId: 'pro' }, { secret: 'test-secret' }),
    )
    expect(bs.syncCalls[0].stripeSubscriptionId).toMatch(/^e2e_bootstrap_sub_ws-XX_/)
    expect(bs.upsertCalls[0].data.stripeCustomerId).toBe('e2e_bootstrap_cus_ws-XX')
  })

  it('returns 500 when billing operation throws', async () => {
    bs.syncThrow = new Error('db gone')
    const res = await app.fetch(
      jsonReq('/bootstrap-subscription', { workspaceId: 'ws-1', planId: 'pro' }, { secret: 'test-secret' }),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('bootstrap_failed')
    expect(body.message).toBe('db gone')
  })
})

describe('GET /subscription-state', () => {
  it('returns 503 when not enabled', async () => {
    setEnv({ NODE_ENV: 'production', SHOGO_E2E_BOOTSTRAP_ENABLED: undefined })
    const res = await app.fetch(
      new Request('http://x/subscription-state?workspaceId=ws-1', {
        headers: { 'x-e2e-bootstrap-secret': 'test-secret' },
      }),
    )
    expect(res.status).toBe(503)
  })

  it('returns 401 when secret is wrong', async () => {
    const res = await app.fetch(
      new Request('http://x/subscription-state?workspaceId=ws-1', {
        headers: { 'x-e2e-bootstrap-secret': 'wrong' },
      }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 when workspaceId is missing', async () => {
    const res = await app.fetch(
      new Request('http://x/subscription-state', {
        headers: { 'x-e2e-bootstrap-secret': 'test-secret' },
      }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('workspaceId_required')
  })

  it('returns subscription + wallet for a valid request', async () => {
    bs.subscriptionReturn = { id: 'sub-1', status: 'active' }
    bs.walletStateReturn = { workspaceId: 'ws-1', remainingUsd: 5 }
    const res = await app.fetch(
      new Request('http://x/subscription-state?workspaceId=ws-1', {
        headers: { 'x-e2e-bootstrap-secret': 'test-secret' },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.subscription).toEqual({ id: 'sub-1', status: 'active' })
    expect(body.wallet).toEqual({ workspaceId: 'ws-1', remainingUsd: 5 })
  })

  it('returns null subscription + wallet when workspace has none', async () => {
    bs.subscriptionReturn = null
    bs.walletStateReturn = null
    const res = await app.fetch(
      new Request('http://x/subscription-state?workspaceId=ws-1', {
        headers: { 'x-e2e-bootstrap-secret': 'test-secret' },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.subscription).toBeNull()
    expect(body.wallet).toBeNull()
  })
})
