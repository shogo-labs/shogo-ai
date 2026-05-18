// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/routes/internal-e2e.ts — the e2e-only "bootstrap a
 * paid subscription" backdoor used by the staging Playwright suite.
 *
 * Three independent guardrails are pinned here:
 *
 *  1. bootstrapEnabled():  NODE_ENV !== 'production' OR
 *                          SHOGO_E2E_BOOTSTRAP_ENABLED === '1'
 *  2. secretMatches():     header `x-e2e-bootstrap-secret` must equal
 *                          `SHOGO_E2E_BOOTSTRAP_SECRET`. Missing env
 *                          ⇒ ALWAYS 401 (no secret-existence hint).
 *  3. e2e- email allowlist on the userEmail lookup branch.
 *
 * All billing-service helpers and prisma are mocked.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

// ─── mocks ────────────────────────────────────────────────────────────────

const upsertBillingAccountMock = mock(async (_w: string, _o: any) => ({}))
const syncFromStripeMock = mock(async (_o: any) => ({ id: 'sub-1' }))
const allocateMonthlyIncludedMock = mock(async (_w: string, _p: string, _s: number) => ({
  monthlyTokens: 1000,
}))
const getSubscriptionMock = mock(async (_w: string) => null as any)
const getUsageWalletMock = mock(async (_w: string) => null as any)
mock.module('../services/billing.service', () => ({
  upsertBillingAccount: upsertBillingAccountMock,
  syncFromStripe: syncFromStripeMock,
  allocateMonthlyIncluded: allocateMonthlyIncludedMock,
  getSubscription: getSubscriptionMock,
  getUsageWallet: getUsageWalletMock,
}))

const userFindUnique = mock(async (_: any) => null as any)
mock.module('../lib/prisma', () => ({
  prisma: { user: { findUnique: userFindUnique } },
  SubscriptionStatus: { active: 'active' },
  // BillingInterval is only used as a type at compile time; runtime
  // value isn't read by the route, but provide a stub for the import.
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

const { default: e2eApp } = await import('../routes/internal-e2e')

// ─── helpers ──────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono()
  app.route('/api/internal/e2e', e2eApp)
  return app
}

const ENV_KEYS = [
  'NODE_ENV',
  'SHOGO_E2E_BOOTSTRAP_ENABLED',
  'SHOGO_E2E_BOOTSTRAP_SECRET',
] as const
const SAVED: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k]
    delete process.env[k]
  }
  // Defaults for happy-path tests: non-prod + secret set.
  process.env.NODE_ENV = 'test'
  process.env.SHOGO_E2E_BOOTSTRAP_SECRET = 'top-secret'

  upsertBillingAccountMock.mockReset()
  upsertBillingAccountMock.mockImplementation(async () => ({}))
  syncFromStripeMock.mockReset()
  syncFromStripeMock.mockImplementation(async (o: any) => ({
    id: o.stripeSubscriptionId,
    workspaceId: o.workspaceId,
    planId: o.planId,
    seats: o.seats,
    billingInterval: o.billingInterval,
    status: o.status,
  }))
  allocateMonthlyIncludedMock.mockReset()
  allocateMonthlyIncludedMock.mockImplementation(async () => ({ monthlyTokens: 1000 }))
  getSubscriptionMock.mockReset()
  getUsageWalletMock.mockReset()
  userFindUnique.mockReset()
  userFindUnique.mockImplementation(async () => null)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
})

function bootstrapBody(over: any = {}) {
  return JSON.stringify({
    workspaceId: 'ws-1',
    planId: 'pro',
    seats: 1,
    billingInterval: 'monthly',
    ...over,
  })
}

function authedPost(path: string, body?: string, secret = 'top-secret') {
  return makeApp().request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-e2e-bootstrap-secret': secret,
    },
    body: body ?? '{}',
  })
}

// ─── guard: bootstrapEnabled() ────────────────────────────────────────────

describe('guardrail #1: bootstrapEnabled', () => {
  test('production + override unset → 503 e2e_bootstrap_disabled (POST)', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.SHOGO_E2E_BOOTSTRAP_ENABLED
    const res = await authedPost('/api/internal/e2e/bootstrap-subscription', bootstrapBody())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('e2e_bootstrap_disabled')
    expect(body.message).toContain('SHOGO_E2E_BOOTSTRAP_ENABLED=1')
    expect(syncFromStripeMock).not.toHaveBeenCalled()
  })

  test('production + SHOGO_E2E_BOOTSTRAP_ENABLED=1 → passes (override engaged)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.SHOGO_E2E_BOOTSTRAP_ENABLED = '1'
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody(),
    )
    expect(res.status).toBe(200)
  })

  test('production + override="true" (not "1") → STILL disabled (strict-eq check pinned)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.SHOGO_E2E_BOOTSTRAP_ENABLED = 'true'
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody(),
    )
    expect(res.status).toBe(503)
  })

  test('non-prod (NODE_ENV unset) → enabled without any override', async () => {
    delete process.env.NODE_ENV
    delete process.env.SHOGO_E2E_BOOTSTRAP_ENABLED
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody(),
    )
    expect(res.status).toBe(200)
  })

  test('GET /subscription-state is also 503 when disabled', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.SHOGO_E2E_BOOTSTRAP_ENABLED
    const res = await makeApp().request(
      '/api/internal/e2e/subscription-state?workspaceId=ws-1',
      { headers: { 'x-e2e-bootstrap-secret': 'top-secret' } },
    )
    expect(res.status).toBe(503)
  })
})

// ─── guard: secretMatches() ───────────────────────────────────────────────

describe('guardrail #2: secretMatches', () => {
  test('missing SHOGO_E2E_BOOTSTRAP_SECRET env → ALWAYS 401 (even with no header)', async () => {
    delete process.env.SHOGO_E2E_BOOTSTRAP_SECRET
    const res = await makeApp().request('/api/internal/e2e/bootstrap-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bootstrapBody(),
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unauthorized')
  })

  test('missing header → 401 unauthorized', async () => {
    const res = await makeApp().request('/api/internal/e2e/bootstrap-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bootstrapBody(),
    })
    expect(res.status).toBe(401)
  })

  test('wrong header value → 401 unauthorized', async () => {
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody(),
      'totally-wrong',
    )
    expect(res.status).toBe(401)
  })

  test('response message is intentionally generic (no env-name leakage)', async () => {
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody(),
      'wrong',
    )
    const body = await res.json()
    expect(body.error).toBe('unauthorized')
    expect(JSON.stringify(body)).not.toContain('SHOGO_E2E_BOOTSTRAP_SECRET')
  })

  test('GET /subscription-state also requires the secret', async () => {
    const res = await makeApp().request(
      '/api/internal/e2e/subscription-state?workspaceId=ws-1',
    )
    expect(res.status).toBe(401)
  })
})

// ─── POST /bootstrap-subscription — body validation ───────────────────────

describe('POST /bootstrap-subscription — body validation', () => {
  test('400 invalid_json when body is not parseable', async () => {
    const res = await makeApp().request('/api/internal/e2e/bootstrap-subscription', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-e2e-bootstrap-secret': 'top-secret',
      },
      body: 'not-json{',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_json')
  })

  test('400 invalid_planId when planId is not in {basic, pro, business}', async () => {
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ planId: 'enterprise' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_planId')
    expect(body.allowed.sort()).toEqual(['basic', 'business', 'pro'])
    expect(syncFromStripeMock).not.toHaveBeenCalled()
  })

  test('planId defaults to "pro" when missing', async () => {
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ planId: undefined }),
    )
    expect(res.status).toBe(200)
    expect(syncFromStripeMock.mock.calls[0][0].planId).toBe('pro')
  })

  test('seats clamped to at least 1 (Math.max(1, floor(seats)))', async () => {
    await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ seats: 0 }),
    )
    expect(syncFromStripeMock.mock.calls[0][0].seats).toBe(1)

    syncFromStripeMock.mockClear()
    await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ seats: -5 }),
    )
    expect(syncFromStripeMock.mock.calls[0][0].seats).toBe(1)

    syncFromStripeMock.mockClear()
    await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ seats: 3.9 }),
    )
    expect(syncFromStripeMock.mock.calls[0][0].seats).toBe(3) // floored
  })

  test('billingInterval defaults to "monthly" and rejects unknown values silently → monthly', async () => {
    await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ billingInterval: 'lifetime' }),
    )
    expect(syncFromStripeMock.mock.calls[0][0].billingInterval).toBe('monthly')

    syncFromStripeMock.mockClear()
    await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ billingInterval: 'annual' }),
    )
    expect(syncFromStripeMock.mock.calls[0][0].billingInterval).toBe('annual')
  })

  test('daysUntilPeriodEnd clamped to [1, 365] and floored', async () => {
    await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ daysUntilPeriodEnd: 0 }),
    )
    let call = syncFromStripeMock.mock.calls[0][0]
    let span = call.currentPeriodEnd.getTime() - call.currentPeriodStart.getTime()
    expect(Math.round(span / (24 * 3600_000))).toBe(1) // clamped to 1 day

    syncFromStripeMock.mockClear()
    await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ daysUntilPeriodEnd: 99999 }),
    )
    call = syncFromStripeMock.mock.calls[0][0]
    span = call.currentPeriodEnd.getTime() - call.currentPeriodStart.getTime()
    expect(Math.round(span / (24 * 3600_000))).toBe(365) // clamped to 365 days
  })
})

// ─── POST /bootstrap-subscription — workspace resolution ──────────────────

describe('POST /bootstrap-subscription — workspace resolution', () => {
  test('400 workspaceId_or_userEmail_required when both are missing', async () => {
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ workspaceId: undefined, userEmail: undefined }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('workspaceId_or_userEmail_required')
  })

  test('400 userEmail_must_be_e2e_address when email is not e2e-*@mailnull.com', async () => {
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ workspaceId: undefined, userEmail: 'alice@example.com' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('userEmail_must_be_e2e_address')
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  test('400 when email starts with e2e- but does NOT end with @mailnull.com', async () => {
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ workspaceId: undefined, userEmail: 'e2e-x@example.com' }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('userEmail_must_be_e2e_address')
  })

  test('400 when email ends with @mailnull.com but does NOT start with e2e-', async () => {
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ workspaceId: undefined, userEmail: 'alice@mailnull.com' }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('userEmail_must_be_e2e_address')
  })

  test('email is normalized via lowercase + trim before allowlist check', async () => {
    userFindUnique.mockImplementation(async () => ({
      members: [{ workspaceId: 'ws-from-email' }],
    }))
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({
        workspaceId: undefined,
        userEmail: '  E2E-Pr12345@MAILNULL.com  ',
      }),
    )
    expect(res.status).toBe(200)
    expect(userFindUnique).toHaveBeenCalled()
    expect(userFindUnique.mock.calls[0][0].where.email).toBe(
      'e2e-pr12345@mailnull.com',
    )
  })

  test('404 workspace_not_found_for_user when user has no matching workspace', async () => {
    userFindUnique.mockImplementation(async () => ({ members: [] }))
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({
        workspaceId: undefined,
        userEmail: 'e2e-pr12345@mailnull.com',
      }),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('workspace_not_found_for_user')
    expect(body.email).toBe('e2e-pr12345@mailnull.com')
  })

  test('404 when the user row itself does not exist', async () => {
    userFindUnique.mockImplementation(async () => null)
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({
        workspaceId: undefined,
        userEmail: 'e2e-pr12345@mailnull.com',
      }),
    )
    expect(res.status).toBe(404)
  })

  test('workspaceId takes precedence over userEmail when both are present', async () => {
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({
        workspaceId: 'ws-direct',
        userEmail: 'e2e-pr12345@mailnull.com',
      }),
    )
    expect(res.status).toBe(200)
    expect(userFindUnique).not.toHaveBeenCalled()
    expect(syncFromStripeMock.mock.calls[0][0].workspaceId).toBe('ws-direct')
  })
})

// ─── POST /bootstrap-subscription — happy path + side effects ─────────────

describe('POST /bootstrap-subscription — happy path', () => {
  test('calls billing helpers in order with the right arguments', async () => {
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ workspaceId: 'ws-X', planId: 'business', seats: 3 }),
    )
    expect(res.status).toBe(200)

    expect(upsertBillingAccountMock).toHaveBeenCalledTimes(1)
    expect(upsertBillingAccountMock.mock.calls[0][0]).toBe('ws-X')
    expect(upsertBillingAccountMock.mock.calls[0][1]).toEqual({
      stripeCustomerId: 'e2e_bootstrap_cus_ws-X',
    })

    expect(syncFromStripeMock).toHaveBeenCalledTimes(1)
    const stripeArgs = syncFromStripeMock.mock.calls[0][0]
    expect(stripeArgs.workspaceId).toBe('ws-X')
    expect(stripeArgs.planId).toBe('business')
    expect(stripeArgs.seats).toBe(3)
    expect(stripeArgs.billingInterval).toBe('monthly')
    expect(stripeArgs.status).toBe('active')
    expect(stripeArgs.cancelAtPeriodEnd).toBe(false)
    expect(stripeArgs.stripeCustomerId).toBe('e2e_bootstrap_cus_ws-X')

    expect(allocateMonthlyIncludedMock).toHaveBeenCalledTimes(1)
    expect(allocateMonthlyIncludedMock).toHaveBeenCalledWith('ws-X', 'business', 3)
  })

  test('stripeSubscriptionId is namespaced with the "e2e_bootstrap_" prefix', async () => {
    await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ workspaceId: 'ws-prefix' }),
    )
    const stripeId = syncFromStripeMock.mock.calls[0][0].stripeSubscriptionId
    expect(stripeId).toMatch(/^e2e_bootstrap_sub_ws-prefix_\d+$/)
  })

  test('two consecutive calls for the same workspace produce DIFFERENT subscriptionIds (timestamp suffix)', async () => {
    await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ workspaceId: 'ws-q' }),
    )
    const id1 = syncFromStripeMock.mock.calls[0][0].stripeSubscriptionId
    syncFromStripeMock.mockClear()
    await new Promise((r) => setTimeout(r, 2))
    await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ workspaceId: 'ws-q' }),
    )
    const id2 = syncFromStripeMock.mock.calls[0][0].stripeSubscriptionId
    expect(id1).not.toBe(id2)
  })

  test('response shape: { ok, workspaceId, subscription, wallet }', async () => {
    allocateMonthlyIncludedMock.mockImplementation(async () => ({ monthlyTokens: 5000 }))
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ workspaceId: 'ws-resp' }),
    )
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.workspaceId).toBe('ws-resp')
    expect(body.subscription).toBeDefined()
    expect(body.subscription.workspaceId).toBe('ws-resp')
    expect(body.wallet).toEqual({ monthlyTokens: 5000 })
  })

  test('workspaceId is trimmed before use', async () => {
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody({ workspaceId: '  ws-trim  ' }),
    )
    expect(res.status).toBe(200)
    expect(syncFromStripeMock.mock.calls[0][0].workspaceId).toBe('ws-trim')
  })

  test('500 bootstrap_failed when syncFromStripe throws — error message propagated', async () => {
    syncFromStripeMock.mockImplementation(async () => {
      throw new Error('stripe API exploded')
    })
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody(),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('bootstrap_failed')
    expect(body.message).toBe('stripe API exploded')
  })

  test('500 bootstrap_failed when allocateMonthlyIncluded throws', async () => {
    allocateMonthlyIncludedMock.mockImplementation(async () => {
      throw new Error('wallet allocation failed')
    })
    const res = await authedPost(
      '/api/internal/e2e/bootstrap-subscription',
      bootstrapBody(),
    )
    expect(res.status).toBe(500)
    expect((await res.json()).message).toBe('wallet allocation failed')
  })
})

// ─── GET /subscription-state ──────────────────────────────────────────────

describe('GET /subscription-state', () => {
  test('400 workspaceId_required when query param is missing', async () => {
    const res = await makeApp().request('/api/internal/e2e/subscription-state', {
      headers: { 'x-e2e-bootstrap-secret': 'top-secret' },
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('workspaceId_required')
  })

  test('400 when workspaceId is whitespace-only (trimmed away)', async () => {
    const res = await makeApp().request(
      '/api/internal/e2e/subscription-state?workspaceId=%20%20%20',
      { headers: { 'x-e2e-bootstrap-secret': 'top-secret' } },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('workspaceId_required')
  })

  test('200 returns { ok, subscription, wallet } for an existing workspace', async () => {
    getSubscriptionMock.mockImplementation(async () => ({ id: 'sub-A', planId: 'pro' }))
    getUsageWalletMock.mockImplementation(async () => ({ monthlyTokens: 1000 }))
    const res = await makeApp().request(
      '/api/internal/e2e/subscription-state?workspaceId=ws-A',
      { headers: { 'x-e2e-bootstrap-secret': 'top-secret' } },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.subscription).toEqual({ id: 'sub-A', planId: 'pro' })
    expect(body.wallet).toEqual({ monthlyTokens: 1000 })
    expect(getSubscriptionMock).toHaveBeenCalledWith('ws-A')
    expect(getUsageWalletMock).toHaveBeenCalledWith('ws-A')
  })

  test('200 with nulls when the workspace has no subscription/wallet', async () => {
    getSubscriptionMock.mockImplementation(async () => null)
    getUsageWalletMock.mockImplementation(async () => null)
    const res = await makeApp().request(
      '/api/internal/e2e/subscription-state?workspaceId=ws-empty',
      { headers: { 'x-e2e-bootstrap-secret': 'top-secret' } },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, subscription: null, wallet: null })
  })

  test('workspaceId is trimmed in the query path too', async () => {
    getSubscriptionMock.mockImplementation(async () => ({ id: 's' }))
    getUsageWalletMock.mockImplementation(async () => ({}))
    await makeApp().request(
      '/api/internal/e2e/subscription-state?workspaceId=%20%20ws-Z%20%20',
      { headers: { 'x-e2e-bootstrap-secret': 'top-secret' } },
    )
    expect(getSubscriptionMock).toHaveBeenCalledWith('ws-Z')
  })
})
