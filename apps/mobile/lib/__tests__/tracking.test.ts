// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GA4 purchase tracking tests
 *
 * Run: bun test apps/mobile/lib/__tests__/tracking.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

mock.module('react-native', () => ({
  Platform: { OS: 'web' },
}))

const {
  trackPurchase,
  trackBillingView,
  trackPlanClick,
  trackPlanChange,
  trackCancel,
} = await import('../tracking')

let gtagCalls: unknown[][] = []
let fbqCalls: unknown[][] = []

beforeEach(() => {
  gtagCalls = []
  fbqCalls = []
  window.gtag = (...args: unknown[]) => { gtagCalls.push(args) }
  window.fbq = (...args: unknown[]) => { fbqCalls.push(args) }
})

function gtagEvent(name: string) {
  const call = gtagCalls.find((c) => c[0] === 'event' && c[1] === name)
  return call?.[2] as Record<string, any> | undefined
}

function fbqEvent(name: string) {
  const call = fbqCalls.find((c) => c[1] === name)
  return call?.[2] as Record<string, any> | undefined
}

function purchasePayload() {
  const call = gtagCalls.find((c) => c[0] === 'event' && c[1] === 'purchase')
  return call?.[2] as Record<string, any> | undefined
}

describe('trackPurchase', () => {
  test('sends a numeric USD value for a monthly per-seat plan', () => {
    trackPurchase({ planId: 'pro', billingInterval: 'monthly', seats: 3, sessionId: 'cs_123' })
    const payload = purchasePayload()
    expect(payload?.value).toBe(60)
    expect(payload?.currency).toBe('USD')
    expect(payload?.transaction_id).toBe('cs_123')
    expect(payload?.items[0].item_id).toBe('pro')
  })

  test('sends the annual price for annual plans', () => {
    trackPurchase({ planId: 'basic', billingInterval: 'annual', sessionId: 'cs_456' })
    expect(purchasePayload()?.value).toBe(78)
  })

  test('prefers the amount Stripe charged and its currency', () => {
    trackPurchase({ planId: 'pro', billingInterval: 'monthly', seats: 3, value: 45.5, currency: 'eur', sessionId: 'cs_charged' })
    const payload = purchasePayload()
    expect(payload?.value).toBe(45.5)
    expect(payload?.currency).toBe('EUR')
    expect(payload?.items[0].price).toBe(45.5)
  })

  test('keeps USD for looked-up prices even if a currency is passed', () => {
    trackPurchase({ planId: 'pro', billingInterval: 'monthly', currency: 'eur', sessionId: 'cs_fallback' })
    const payload = purchasePayload()
    expect(payload?.value).toBe(20)
    expect(payload?.currency).toBe('USD')
  })

  test('omits value when billing interval is unknown', () => {
    trackPurchase({ planId: 'pro', sessionId: 'cs_789' })
    expect(purchasePayload()?.value).toBeUndefined()
  })
})

// ============================================================================
// SHO-451 — the billing page's own events
// ============================================================================

describe('trackBillingView', () => {
  test('fires once with the plan and whether the workspace pays', () => {
    trackBillingView({ workspaceId: 'ws_1', planId: 'business', hasSubscription: true })

    const payload = gtagEvent('view_billing')
    expect(payload?.plan_id).toBe('business')
    expect(payload?.has_subscription).toBe(true)
    expect(payload?.workspace_id).toBe('ws_1')
    expect(fbqEvent('BillingView')?.has_subscription).toBe(true)
  })

  test('a free workspace reports no subscription', () => {
    trackBillingView({ workspaceId: 'ws_2', planId: 'free', hasSubscription: false })
    expect(gtagEvent('view_billing')?.has_subscription).toBe(false)
  })
})

describe('trackPlanClick', () => {
  test('a change is never reported as a checkout', () => {
    trackPlanClick({
      planId: 'business',
      action: 'change',
      billingInterval: 'monthly',
      seats: 3,
      workspaceId: 'ws_1',
    })

    const payload = gtagEvent('select_plan')
    expect(payload?.action).toBe('change')
    expect(payload?.plan_id).toBe('business')
    expect(payload?.seats).toBe(3)
    // 3 seats × $16/mo — the same number the plan cards show.
    expect(payload?.value).toBe(48)
    expect(fbqEvent('PlanClick')?.action).toBe('change')
  })

  test('a first subscription is reported as a checkout', () => {
    trackPlanClick({ planId: 'basic', action: 'checkout', billingInterval: 'annual' })
    expect(gtagEvent('select_plan')?.action).toBe('checkout')
    expect(gtagEvent('select_plan')?.value).toBe(78)
  })

  test('a contact-sales click carries no price', () => {
    trackPlanClick({ planId: 'enterprise', action: 'contact' })
    expect(gtagEvent('select_plan')?.action).toBe('contact')
    expect(gtagEvent('select_plan')?.value).toBeUndefined()
  })
})

describe('trackPlanChange', () => {
  test('reports the plan it moved from and the one it moved to', () => {
    trackPlanChange({
      fromPlanId: 'basic',
      planId: 'business',
      billingInterval: 'monthly',
      seats: 2,
      workspaceId: 'ws_1',
    })

    const payload = gtagEvent('change_plan')
    expect(payload?.plan_id).toBe('business')
    expect(payload?.previous_plan_id).toBe('basic')
    expect(payload?.value).toBe(32)
    expect(fbqEvent('PlanChange')?.previous_plan).toBe('basic')
  })
})

describe('trackCancel', () => {
  test('a cancellation and a resume are different events', () => {
    trackCancel({ planId: 'business', action: 'cancel', workspaceId: 'ws_1' })
    expect(gtagEvent('cancel_subscription')?.plan_id).toBe('business')
    expect(fbqEvent('CancelSubscription')).toBeDefined()

    trackCancel({ planId: 'business', action: 'resume', workspaceId: 'ws_1' })
    expect(gtagEvent('resume_subscription')?.plan_id).toBe('business')
    expect(fbqEvent('ResumeSubscription')).toBeDefined()
  })
})
