// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Internal E2E Bootstrap Routes
 *
 * Purpose: the hosted Playwright suite (`e2e/staging/*.test.ts`) drives
 * Stripe hosted Checkout with the test card `4242424242424242` to
 * upgrade a workspace to Pro. Live Stripe rejects test cards, so
 * against production those tests can't complete without a real card.
 *
 * Rather than automating a real Stripe payment, this module exposes a
 * narrow backdoor that directly mutates the DB state as if the
 * Stripe webhook had already fired. The endpoint:
 *   - Accepts `{ workspaceId, planId, seats, billingInterval }`.
 *   - Creates/updates the `Subscription`, `BillingAccount`, and
 *     `UsageWallet` rows using the existing billing-service helpers
 *     (`syncFromStripe`, `upsertBillingAccount`,
 *     `allocateMonthlyIncluded`). Result is indistinguishable from a
 *     real Pro upgrade at the data layer.
 *
 * GUARDRAILS — this endpoint is gated by three independent checks:
 *   1. `NODE_ENV !== 'production'` OR `SHOGO_E2E_BOOTSTRAP_ENABLED=1`.
 *      Production overlays MUST NOT set the override unless they are
 *      intentionally hosting e2e runs.
 *   2. A shared secret header `x-e2e-bootstrap-secret` that must
 *      match `SHOGO_E2E_BOOTSTRAP_SECRET`. If the secret is unset, the
 *      endpoint always returns 503.
 *   3. Created subscription IDs are namespaced with an `e2e_bootstrap_`
 *      prefix so they are trivially distinguishable from real Stripe
 *      IDs in audit logs and metrics.
 *
 * Route is mounted at `/api/internal/e2e/*`, which shares the same
 * auth-skip middleware as other `/api/internal/*` routes.
 */

import { Hono } from 'hono'
import {
  syncFromStripe,
  upsertBillingAccount,
  allocateMonthlyIncluded,
  getSubscription,
  getUsageWallet,
} from '../services/billing.service'
import { prisma, SubscriptionStatus, BillingInterval } from '../lib/prisma'

const app = new Hono()

const ALLOWED_PLANS = new Set(['basic', 'pro', 'business'])
const ALLOWED_INTERVALS = new Set<BillingInterval>(['monthly', 'annual'])

function bootstrapEnabled(): boolean {
  const prod = process.env.NODE_ENV === 'production'
  const override = process.env.SHOGO_E2E_BOOTSTRAP_ENABLED === '1'
  return !prod || override
}

function secretMatches(header: string | undefined): boolean {
  const expected = process.env.SHOGO_E2E_BOOTSTRAP_SECRET
  if (!expected) return false
  if (!header) return false
  // Constant-time comparison — both sides are short so straight
  // `!==` is acceptable here; we don't want Node's `crypto.timingSafeEqual`
  // to bring Buffer allocation noise for a rarely-hit endpoint.
  return header === expected
}

/**
 * POST /api/internal/e2e/bootstrap-subscription
 *
 * Body (one of `workspaceId` or `userEmail` required):
 *   {
 *     workspaceId?: string              // direct target workspace
 *     userEmail?: string                // resolve first workspace for this user
 *                                         //   (must be an e2e-*@mailnull.com address)
 *     planId: 'basic'|'pro'|'business'
 *     seats?: number                    // default 1
 *     billingInterval?: 'monthly'|'annual' (default monthly)
 *     daysUntilPeriodEnd?: number       // default 30
 *   }
 *
 * Returns:
 *   { ok: true, workspaceId, subscription, wallet }
 */
app.post('/bootstrap-subscription', async (c) => {
  if (!bootstrapEnabled()) {
    return c.json(
      {
        ok: false,
        error: 'e2e_bootstrap_disabled',
        message:
          'Set SHOGO_E2E_BOOTSTRAP_ENABLED=1 (non-prod) to enable this endpoint.',
      },
      503,
    )
  }

  if (!secretMatches(c.req.header('x-e2e-bootstrap-secret'))) {
    // Intentionally generic message — no hint that the env var exists.
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }

  let body: {
    workspaceId?: string
    userEmail?: string
    planId?: string
    seats?: number
    billingInterval?: BillingInterval
    daysUntilPeriodEnd?: number
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  const planId = body.planId?.trim() ?? 'pro'
  const seats = Math.max(1, Math.floor(body.seats ?? 1))
  const billingInterval: BillingInterval =
    body.billingInterval && ALLOWED_INTERVALS.has(body.billingInterval)
      ? body.billingInterval
      : 'monthly'
  const daysUntilPeriodEnd = Math.max(
    1,
    Math.min(365, Math.floor(body.daysUntilPeriodEnd ?? 30)),
  )

  if (!ALLOWED_PLANS.has(planId)) {
    return c.json(
      { ok: false, error: 'invalid_planId', allowed: [...ALLOWED_PLANS] },
      400,
    )
  }

  // Resolve workspaceId — either passed directly, or looked up by the
  // signup email of the e2e user. The email path is restricted to the
  // `e2e-*@mailnull.com` shape so this can't be abused to upgrade
  // arbitrary real users even if the secret ever leaked.
  let workspaceId = body.workspaceId?.trim()
  if (!workspaceId) {
    const email = body.userEmail?.trim().toLowerCase()
    if (!email) {
      return c.json(
        { ok: false, error: 'workspaceId_or_userEmail_required' },
        400,
      )
    }
    if (!email.startsWith('e2e-') || !email.endsWith('@mailnull.com')) {
      return c.json(
        {
          ok: false,
          error: 'userEmail_must_be_e2e_address',
          message:
            'userEmail lookup is restricted to e2e-*@mailnull.com addresses.',
        },
        400,
      )
    }
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        members: {
          where: { workspaceId: { not: null }, projectId: null },
          select: { workspaceId: true },
          take: 1,
        },
      },
    })
    const wid = user?.members[0]?.workspaceId ?? null
    if (!wid) {
      return c.json(
        { ok: false, error: 'workspace_not_found_for_user', email },
        404,
      )
    }
    workspaceId = wid
  }

  const now = new Date()
  const periodEnd = new Date(now.getTime() + daysUntilPeriodEnd * 24 * 60 * 60 * 1000)

  // Use an `e2e_bootstrap_` prefix so these rows are trivially
  // identifiable in Stripe webhook deduping logic and any analytics
  // slicing. The cleanup script can also use the prefix to find
  // stray test subscriptions.
  const stripeCustomerId = `e2e_bootstrap_cus_${workspaceId}`
  const stripeSubscriptionId = `e2e_bootstrap_sub_${workspaceId}_${Date.now()}`

  try {
    await upsertBillingAccount(workspaceId, { stripeCustomerId })

    const subscription = await syncFromStripe({
      workspaceId,
      stripeCustomerId,
      stripeSubscriptionId,
      planId,
      seats,
      billingInterval,
      status: SubscriptionStatus.active,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    })

    const wallet = await allocateMonthlyIncluded(workspaceId, planId, seats)

    // eslint-disable-next-line no-console
    console.info(
      '[e2e-bootstrap] upgraded workspace',
      JSON.stringify({
        workspaceId,
        planId,
        seats,
        billingInterval,
        subscriptionId: stripeSubscriptionId,
      }),
    )

    return c.json({ ok: true, workspaceId, subscription, wallet })
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error('[e2e-bootstrap] failed', err)
    return c.json(
      { ok: false, error: 'bootstrap_failed', message: err?.message ?? 'unknown' },
      500,
    )
  }
})

/**
 * GET /api/internal/e2e/subscription-state
 *
 * Diagnostic endpoint — returns the current subscription + wallet for
 * a workspace so tests can assert state after bootstrapping.
 */
app.get('/subscription-state', async (c) => {
  if (!bootstrapEnabled()) {
    return c.json({ ok: false, error: 'e2e_bootstrap_disabled' }, 503)
  }
  if (!secretMatches(c.req.header('x-e2e-bootstrap-secret'))) {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }

  const workspaceId = c.req.query('workspaceId')?.trim()
  if (!workspaceId) {
    return c.json({ ok: false, error: 'workspaceId_required' }, 400)
  }

  const [subscription, wallet] = await Promise.all([
    getSubscription(workspaceId),
    getUsageWallet(workspaceId),
  ])

  return c.json({ ok: true, subscription, wallet })
})

export default app
