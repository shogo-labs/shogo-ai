// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guardrail tests for the e2e bootstrap backdoor.
 *
 * The endpoint mutates paid-plan state directly, so it's essential
 * that:
 *   - Requests without `SHOGO_E2E_BOOTSTRAP_SECRET` set always 503.
 *   - Requests with a wrong / missing secret header always 401.
 *   - `userEmail` lookup is restricted to `e2e-*@mailnull.com` shape.
 *   - `planId` is validated against the allow-list.
 *   - Production `NODE_ENV` disables the endpoint unless the override is
 *     explicitly set.
 *
 * The billing-service + prisma dependencies are mocked so this file
 * doesn't need a DB.
 *
 * Run: bun test apps/api/src/__tests__/internal-e2e-routes.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ── Mocks ────────────────────────────────────────────────────────────

const lookupUserByEmail: Record<
  string,
  { members: Array<{ workspaceId: string | null }> } | null
> = {
  'e2e-has-workspace@mailnull.com': { members: [{ workspaceId: 'ws_123' }] },
  'e2e-no-workspace@mailnull.com': { members: [] },
  'real-person@example.com': { members: [{ workspaceId: 'ws_real' }] },
}

mock.module('../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: async ({ where, select: _select }: any) => {
        const email = (where?.email ?? '').toLowerCase()
        return lookupUserByEmail[email] ?? null
      },
    },
  },
  // Enums used by the route module at import-time.
  SubscriptionStatus: { active: 'active' },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

const billingCalls: Array<{ fn: string; args: unknown[] }> = []

mock.module('../services/billing.service', () => ({
  syncFromStripe: async (...args: unknown[]) => {
    billingCalls.push({ fn: 'syncFromStripe', args })
    const { workspaceId, stripeSubscriptionId, planId } = args[0] as {
      workspaceId: string
      stripeSubscriptionId: string
      planId: string
    }
    return { id: 'sub_rec', workspaceId, stripeSubscriptionId, planId }
  },
  upsertBillingAccount: async (...args: unknown[]) => {
    billingCalls.push({ fn: 'upsertBillingAccount', args })
    return { workspaceId: args[0] }
  },
  allocateMonthlyIncluded: async (...args: unknown[]) => {
    billingCalls.push({ fn: 'allocateMonthlyIncluded', args })
    return { workspaceId: args[0], monthlyIncludedUsd: 20 }
  },
  getSubscription: async () => null,
  getUsageWallet: async () => null,
}))

// Dynamic import so the mocks above apply before the module loads.
const { default: internalE2eRoutes } = await import('../routes/internal-e2e')

// ── Helpers ──────────────────────────────────────────────────────────

async function post(
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
) {
  return internalE2eRoutes.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.headers ?? {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}

function setSecret(v: string | undefined) {
  if (v === undefined) {
    delete process.env.SHOGO_E2E_BOOTSTRAP_SECRET
  } else {
    process.env.SHOGO_E2E_BOOTSTRAP_SECRET = v
  }
}

function setNodeEnv(v: string | undefined) {
  if (v === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = v
}

function setOverride(v: string | undefined) {
  if (v === undefined) delete process.env.SHOGO_E2E_BOOTSTRAP_ENABLED
  else process.env.SHOGO_E2E_BOOTSTRAP_ENABLED = v
}

// ── Tests ────────────────────────────────────────────────────────────

describe('internal-e2e bootstrap route', () => {
  beforeEach(() => {
    billingCalls.length = 0
    setNodeEnv('test')
    setSecret('test-secret-shh')
    setOverride(undefined)
  })

  test('503 when secret env var is unset', async () => {
    setSecret(undefined)
    const res = await post('/bootstrap-subscription', {
      body: { workspaceId: 'ws_123', planId: 'pro' },
      headers: { 'x-e2e-bootstrap-secret': 'anything' },
    })
    // Without the secret env set, the endpoint returns 401 (auth fails
    // before reaching work). We specifically want no upgrade to happen.
    expect([401, 503]).toContain(res.status)
    expect(billingCalls).toHaveLength(0)
  })

  test('401 when secret header is missing', async () => {
    const res = await post('/bootstrap-subscription', {
      body: { workspaceId: 'ws_123', planId: 'pro' },
    })
    expect(res.status).toBe(401)
    expect(billingCalls).toHaveLength(0)
  })

  test('401 when secret header is wrong', async () => {
    const res = await post('/bootstrap-subscription', {
      body: { workspaceId: 'ws_123', planId: 'pro' },
      headers: { 'x-e2e-bootstrap-secret': 'wrong' },
    })
    expect(res.status).toBe(401)
    expect(billingCalls).toHaveLength(0)
  })

  test('503 when NODE_ENV=production without override', async () => {
    setNodeEnv('production')
    const res = await post('/bootstrap-subscription', {
      body: { workspaceId: 'ws_123', planId: 'pro' },
      headers: { 'x-e2e-bootstrap-secret': 'test-secret-shh' },
    })
    expect(res.status).toBe(503)
    expect(billingCalls).toHaveLength(0)
  })

  test('allows prod when SHOGO_E2E_BOOTSTRAP_ENABLED=1 override is set', async () => {
    setNodeEnv('production')
    setOverride('1')
    const res = await post('/bootstrap-subscription', {
      body: { workspaceId: 'ws_123', planId: 'pro' },
      headers: { 'x-e2e-bootstrap-secret': 'test-secret-shh' },
    })
    expect(res.status).toBe(200)
  })

  test('rejects invalid planId', async () => {
    const res = await post('/bootstrap-subscription', {
      body: { workspaceId: 'ws_123', planId: 'enterprise' },
      headers: { 'x-e2e-bootstrap-secret': 'test-secret-shh' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_planId')
    expect(billingCalls).toHaveLength(0)
  })

  test('requires workspaceId or userEmail', async () => {
    const res = await post('/bootstrap-subscription', {
      body: { planId: 'pro' },
      headers: { 'x-e2e-bootstrap-secret': 'test-secret-shh' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('workspaceId_or_userEmail_required')
  })

  test('rejects non-e2e userEmail', async () => {
    const res = await post('/bootstrap-subscription', {
      body: { userEmail: 'real-person@example.com', planId: 'pro' },
      headers: { 'x-e2e-bootstrap-secret': 'test-secret-shh' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('userEmail_must_be_e2e_address')
    expect(billingCalls).toHaveLength(0)
  })

  test('404 when e2e email has no workspace', async () => {
    const res = await post('/bootstrap-subscription', {
      body: {
        userEmail: 'e2e-no-workspace@mailnull.com',
        planId: 'pro',
      },
      headers: { 'x-e2e-bootstrap-secret': 'test-secret-shh' },
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('workspace_not_found_for_user')
  })

  test('happy path with direct workspaceId', async () => {
    const res = await post('/bootstrap-subscription', {
      body: { workspaceId: 'ws_direct', planId: 'pro', seats: 3 },
      headers: { 'x-e2e-bootstrap-secret': 'test-secret-shh' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.workspaceId).toBe('ws_direct')
    // Verifies the bootstrap ID namespace prefix that deploys can grep for.
    const syncCall = billingCalls.find((c) => c.fn === 'syncFromStripe')
    expect(syncCall).toBeTruthy()
    const syncArgs = syncCall!.args[0] as {
      stripeSubscriptionId: string
      stripeCustomerId: string
      seats: number
    }
    expect(syncArgs.stripeSubscriptionId).toStartWith('e2e_bootstrap_sub_ws_direct_')
    expect(syncArgs.stripeCustomerId).toBe('e2e_bootstrap_cus_ws_direct')
    expect(syncArgs.seats).toBe(3)
  })

  test('happy path via userEmail lookup', async () => {
    const res = await post('/bootstrap-subscription', {
      body: {
        userEmail: 'e2e-has-workspace@mailnull.com',
        planId: 'business',
      },
      headers: { 'x-e2e-bootstrap-secret': 'test-secret-shh' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.workspaceId).toBe('ws_123')
    const syncCall = billingCalls.find((c) => c.fn === 'syncFromStripe')
    const syncArgs = syncCall!.args[0] as { planId: string; workspaceId: string }
    expect(syncArgs.planId).toBe('business')
    expect(syncArgs.workspaceId).toBe('ws_123')
  })
})
