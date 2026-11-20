// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-472 regression: grant workspaces (no Stripe Subscription row) must show
 * advanced models as unlocked on mobile after the workspace-plan hotfix.
 *
 * The original bug: `hasAdvancedModelAccess` derived from the subscription row
 * only. Grant workspaces have no row → `subscription = undefined` → models
 * locked. The fix adds a `paidTier`-based fallback: when the workspace-plan
 * endpoint says `paidTier: true` and the effective plan is not basic/free,
 * advanced models unlock regardless of the synthetic-subscription path.
 */
import { describe, expect, test } from 'bun:test'

/**
 * Pure extraction of the `hasAdvancedModelAccess` derivation from
 * `useBillingData`. Kept here (not exported from the hook) so the test does
 * not depend on the hook's React internals.
 */
function computeHasAdvancedModelAccess(params: {
  subscription: { status: string; planId: string } | undefined
  paidTier: boolean | null
  effectivePlanId: string
}): boolean {
  const { subscription, paidTier, effectivePlanId } = params
  const hasActiveSubscription =
    subscription?.status === 'active' || subscription?.status === 'trialing'
  return (
    (hasActiveSubscription && subscription?.planId !== 'basic') ||
    (paidTier === true && effectivePlanId !== 'basic' && effectivePlanId !== 'free')
  )
}

describe('hasAdvancedModelAccess — grant workspace (SHO-472)', () => {
  test('grant workspace: locked when workspace-plan has not yet resolved', () => {
    // Simulates the outage window: workspace-plan returned 500, paidTier = null
    expect(
      computeHasAdvancedModelAccess({
        subscription: undefined,
        paidTier: null,
        effectivePlanId: 'free',
      }),
    ).toBe(false)
  })

  test('grant workspace: unlocked via paidTier once workspace-plan resolves (enterprise)', () => {
    // After hotfix: workspace-plan returns { paidTier: true, planId: 'enterprise', source: 'grant' }
    // paidTier fallback must unlock models without needing the synthetic subscription.
    expect(
      computeHasAdvancedModelAccess({
        subscription: undefined,
        paidTier: true,
        effectivePlanId: 'enterprise',
      }),
    ).toBe(true)
  })

  test('grant workspace: unlocked via paidTier once workspace-plan resolves (business)', () => {
    expect(
      computeHasAdvancedModelAccess({
        subscription: undefined,
        paidTier: true,
        effectivePlanId: 'business',
      }),
    ).toBe(true)
  })

  test('grant workspace: still locked when paidTier = true but plan is basic', () => {
    // A Basic-only grant should not unlock standard/premium models.
    expect(
      computeHasAdvancedModelAccess({
        subscription: undefined,
        paidTier: true,
        effectivePlanId: 'basic',
      }),
    ).toBe(false)
  })

  test('grant workspace: still locked when paidTier = false', () => {
    expect(
      computeHasAdvancedModelAccess({
        subscription: undefined,
        paidTier: false,
        effectivePlanId: 'enterprise',
      }),
    ).toBe(false)
  })

  test('synthetic subscription path still works when effectivePlan.source is grant', () => {
    // The original fix: a synthetic subscription { status: 'active', planId: 'enterprise' }
    // is built from effectivePlan. This path must continue to unlock models.
    expect(
      computeHasAdvancedModelAccess({
        subscription: { status: 'active', planId: 'enterprise' },
        paidTier: true,
        effectivePlanId: 'enterprise',
      }),
    ).toBe(true)
  })

  test('Stripe-subscription path: active basic does not unlock advanced models', () => {
    expect(
      computeHasAdvancedModelAccess({
        subscription: { status: 'active', planId: 'basic' },
        paidTier: false,
        effectivePlanId: 'basic',
      }),
    ).toBe(false)
  })

  test('Stripe-subscription path: active pro unlocks advanced models', () => {
    expect(
      computeHasAdvancedModelAccess({
        subscription: { status: 'active', planId: 'pro' },
        paidTier: true,
        effectivePlanId: 'pro',
      }),
    ).toBe(true)
  })
})
