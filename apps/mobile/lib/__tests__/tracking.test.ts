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

const { trackPurchase } = await import('../tracking')

let gtagCalls: unknown[][] = []

beforeEach(() => {
  gtagCalls = []
  window.gtag = (...args: unknown[]) => { gtagCalls.push(args) }
  window.fbq = () => {}
})

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
    expect(purchasePayload()?.value).toBe(80)
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
