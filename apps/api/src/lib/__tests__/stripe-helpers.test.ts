// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { STRIPE_API_VERSION, resolveInvoiceSubscriptionId } from '../stripe-helpers'

describe('STRIPE_API_VERSION', () => {
  it('is pinned to a stable, explicit version string', () => {
    // A change here is intentional and must be reviewed: it shifts the
    // request/response shape every server-side Stripe client speaks.
    expect(STRIPE_API_VERSION).toBe('2026-01-28.clover')
  })
})

describe('resolveInvoiceSubscriptionId', () => {
  it('reads the legacy top-level string `subscription`', () => {
    expect(resolveInvoiceSubscriptionId({ subscription: 'sub_legacy' })).toBe('sub_legacy')
  })

  it('reads a legacy expanded `subscription` object via its id', () => {
    expect(resolveInvoiceSubscriptionId({ subscription: { id: 'sub_expanded' } })).toBe('sub_expanded')
  })

  it('reads the 2025+ `parent.subscription_details.subscription` string', () => {
    // This is the shape the account actually sends now — the regression that
    // silently broke the receipt-email + monthly-refill path.
    const invoice = { parent: { subscription_details: { subscription: 'sub_new' } } }
    expect(resolveInvoiceSubscriptionId(invoice)).toBe('sub_new')
  })

  it('reads the 2025+ nested subscription when expanded into an object', () => {
    const invoice = { parent: { subscription_details: { subscription: { id: 'sub_new_obj' } } } }
    expect(resolveInvoiceSubscriptionId(invoice)).toBe('sub_new_obj')
  })

  it('prefers the legacy field when both shapes are present', () => {
    const invoice = {
      subscription: 'sub_legacy',
      parent: { subscription_details: { subscription: 'sub_new' } },
    }
    expect(resolveInvoiceSubscriptionId(invoice)).toBe('sub_legacy')
  })

  it('returns null for a one-off invoice with no subscription anywhere', () => {
    expect(resolveInvoiceSubscriptionId({ parent: { subscription_details: {} } })).toBeNull()
    expect(resolveInvoiceSubscriptionId({})).toBeNull()
  })

  it('is null-safe for null / undefined / non-object inputs', () => {
    expect(resolveInvoiceSubscriptionId(null)).toBeNull()
    expect(resolveInvoiceSubscriptionId(undefined)).toBeNull()
    expect(resolveInvoiceSubscriptionId('not-an-invoice')).toBeNull()
  })

  it('treats an empty-string subscription as no subscription', () => {
    expect(resolveInvoiceSubscriptionId({ subscription: '' })).toBeNull()
  })
})
