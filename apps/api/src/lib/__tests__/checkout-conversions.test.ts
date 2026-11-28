// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a paid checkout reports (SHO-611, AC3).
 *
 * The mapping is pure, so every case is a fixture session — no Stripe, no Meta,
 * no Cometly, no network.
 */
import { describe, test, expect } from 'bun:test'
import {
  buildCheckoutConversionEvents,
  isPaidSubscriptionCheckout,
  metaBrowserCookies,
  type CheckoutSessionLike,
} from '../checkout-conversions'
import { hashEmail } from '../meta-capi'

const NOW = 1_700_000_000_000

function paidSession(overrides: Partial<CheckoutSessionLike> = {}): CheckoutSessionLike {
  return {
    id: 'cs_test_123',
    mode: 'subscription',
    amount_total: 4800,
    currency: 'usd',
    created: 1_699_999_000,
    customer_details: { email: 'Ada@Example.com' },
    metadata: { workspaceId: 'ws_1', planId: 'business', billingInterval: 'monthly', seats: '3' },
    ...overrides,
  }
}

describe('isPaidSubscriptionCheckout', () => {
  test('a paid plan checkout counts', () => {
    expect(isPaidSubscriptionCheckout(paidSession())).toBe(true)
  })

  test('a $0 session (a free trial\u2019s card setup) does not', () => {
    expect(isPaidSubscriptionCheckout(paidSession({ amount_total: 0 }))).toBe(false)
    expect(isPaidSubscriptionCheckout(paidSession({ amount_total: null }))).toBe(false)
  })

  test('instance and capacity add-ons do not', () => {
    for (const checkoutType of ['instance', 'capacity']) {
      const session = paidSession({
        metadata: { workspaceId: 'ws_1', checkoutType, instanceSize: 'small' },
      })
      expect(isPaidSubscriptionCheckout(session)).toBe(false)
    }
  })

  test('a one-off payment session is not a subscription purchase', () => {
    expect(isPaidSubscriptionCheckout(paidSession({ mode: 'payment' }))).toBe(false)
  })
})

describe('buildCheckoutConversionEvents', () => {
  test('builds exactly one Purchase and one Subscribe, with the browser\u2019s ids', () => {
    const { meta } = buildCheckoutConversionEvents(paidSession(), { userId: 'user-1' }, NOW)

    expect(meta).toHaveLength(2)
    expect(meta[0]!.event_name).toBe('Purchase')
    expect(meta[0]!.event_id).toBe('cs_test_123')
    expect(meta[1]!.event_name).toBe('Subscribe')
    expect(meta[1]!.event_id).toBe('cs_test_123_sub')
    // The same ids `trackPurchase` sends from the browser.
    expect(meta[0]!.event_id).toBe('cs_test_123')
  })

  test('carries value and currency from the session, and the buyer\u2019s hashed ids', () => {
    const { meta } = buildCheckoutConversionEvents(paidSession(), { userId: 'user-1' }, NOW)

    for (const event of meta) {
      expect(event.custom_data?.value).toBe(48)
      expect(event.custom_data?.currency).toBe('USD')
      expect(event.custom_data?.content_ids).toEqual(['business'])
      expect(event.user_data.em).toEqual([hashEmail('ada@example.com')])
      expect(event.user_data.external_id).toEqual([hashEmail('user-1')])
      // `created` is Stripe's own timestamp, in seconds.
      expect(event.event_time).toBe(1_699_999_000)
    }
  })

  test('a retried webhook builds the same ids, so Meta keeps one purchase', () => {
    const first = buildCheckoutConversionEvents(paidSession(), { userId: 'user-1' }, NOW)
    const retry = buildCheckoutConversionEvents(paidSession(), { userId: 'user-1' }, NOW + 60_000)
    expect(retry.meta.map((e) => e.event_id)).toEqual(first.meta.map((e) => e.event_id))
  })

  test('an add-on session builds nothing at all', () => {
    const events = buildCheckoutConversionEvents(
      paidSession({ metadata: { workspaceId: 'ws_1', checkoutType: 'instance' } }),
      { userId: 'user-1' },
      NOW,
    )
    expect(events.meta).toEqual([])
    expect(events.cometly).toBeNull()
  })

  test('a $0 session builds nothing at all', () => {
    const events = buildCheckoutConversionEvents(paidSession({ amount_total: 0 }), null, NOW)
    expect(events.meta).toEqual([])
    expect(events.cometly).toBeNull()
  })

  test('takes fbc/fbp from the session metadata before the attribution row', () => {
    const { meta } = buildCheckoutConversionEvents(
      paidSession({ metadata: { workspaceId: 'ws_1', planId: 'business', fbc: 'fb.1.1.meta', fbp: 'fb.1.1.browser' } }),
      { userId: 'user-1', fbc: 'fb.1.1.rowe', fbp: 'fb.1.1.rowb' },
      NOW,
    )
    expect(meta[0]!.user_data.fbc).toBe('fb.1.1.meta')
    expect(meta[0]!.user_data.fbp).toBe('fb.1.1.browser')
  })

  test('falls back to the attribution row, and derives fbc from a bare fbclid', () => {
    const { meta } = buildCheckoutConversionEvents(
      paidSession(),
      { userId: 'user-1', fbclid: 'IwARclick', fbp: 'fb.1.1.rowb' },
      NOW,
    )
    expect(meta[0]!.user_data.fbc).toBe('fb.1.1700000000000.IwARclick')
    expect(meta[0]!.user_data.fbp).toBe('fb.1.1.rowb')
  })

  test('reports the purchase to Cometly, keyed by the session id, when there is an email', () => {
    const { cometly } = buildCheckoutConversionEvents(paidSession(), { userId: 'user-1' }, NOW)
    expect(cometly).toEqual({
      eventName: 'purchase',
      email: 'Ada@Example.com',
      idempotencyKey: 'cs_test_123',
      cometToken: null,
      eventTime: '2023-11-14T21:56:40.000Z',
    })
  })

  test('with no email there is nothing for Cometly to key on, so nothing is sent', () => {
    const { meta, cometly } = buildCheckoutConversionEvents(
      paidSession({ customer_details: null }),
      { userId: 'user-1' },
      NOW,
    )
    expect(cometly).toBeNull()
    // Meta still gets the purchase, matched on the hashed user id.
    expect(meta).toHaveLength(2)
    expect(meta[0]!.user_data.external_id).toEqual([hashEmail('user-1')])
  })

  test('a session with no metadata still reports the purchase', () => {
    const { meta } = buildCheckoutConversionEvents(paidSession({ metadata: null }), null, NOW)
    expect(meta.map((e) => e.event_name)).toEqual(['Purchase', 'Subscribe'])
  })
})

describe('metaBrowserCookies', () => {
  test('lifts _fbp and _fbc out of a busy cookie header', () => {
    const header = 'theme=dark; _fbp=fb.1.1.browser; better-auth.session=abc; _fbc=fb.1.1.click'
    expect(metaBrowserCookies(header)).toEqual({ fbp: 'fb.1.1.browser', fbc: 'fb.1.1.click' })
  })

  test('a visitor who blocked the pixel contributes nothing', () => {
    expect(metaBrowserCookies('theme=dark; better-auth.session=abc')).toEqual({})
    expect(metaBrowserCookies(null)).toEqual({})
  })
})
