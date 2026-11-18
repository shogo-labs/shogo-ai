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

const { trackPurchase, trackLogin, trackSignUp } = await import('../tracking')

let gtagCalls: unknown[][] = []
let fbqCalls: unknown[][] = []

beforeEach(() => {
  gtagCalls = []
  window.gtag = (...args: unknown[]) => { gtagCalls.push(args) }
  fbqCalls = []
  window.fbq = (...args: unknown[]) => { fbqCalls.push(args) }
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

describe('Meta events on auth', () => {
  test('a sign-in never fires Meta Lead (Lead is reserved for funnel results)', () => {
    trackLogin('google')
    expect(fbqCalls).toHaveLength(0)
    expect(gtagCalls.some((c) => c[1] === 'login')).toBe(true)
  })

  test('sign-up uses signup_<userId> so the server CAPI twin dedupes', () => {
    trackSignUp('email', 'user-42')
    const call = fbqCalls.find((c) => c[1] === 'CompleteRegistration')
    expect(call?.[3]).toEqual({ eventID: 'signup_user-42' })
  })

  test('without a user id it still fires, with a generated id', () => {
    trackSignUp('email')
    const call = fbqCalls.find((c) => c[1] === 'CompleteRegistration')
    expect((call?.[3] as any).eventID).toMatch(/^signup_\d+_\d+$/)
  })
})
