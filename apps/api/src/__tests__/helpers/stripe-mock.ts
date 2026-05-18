// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Reusable stub for the `stripe` SDK.
 *
 * `analytics.service.ts`, `cost-analytics.service.ts`, and the billing
 * routes touch a moderately large slice of the Stripe API. Each test
 * file ended up re-declaring its own mock; this helper centralises the
 * default-empty shape and lets tests override only the methods they
 * exercise.
 *
 * Usage:
 *
 *     import { makeStripeStub } from './helpers/stripe-mock'
 *     const stripe = makeStripeStub({
 *       customers: { retrieve: async (id) => ({ id, balance: 0 }) },
 *     })
 *     mock.module('stripe', () => ({ default: class { constructor() { return stripe } } }))
 */

type AsyncFn = (...args: any[]) => Promise<any>

interface StripeListPage<T = any> {
  data: T[]
  has_more: boolean
  object: 'list'
}

function asyncList<T>(items: T[] = []): AsyncFn {
  return async () => ({ data: items, has_more: false, object: 'list' as const })
}

function asyncEmpty(): AsyncFn {
  return async () => ({})
}

export type StripeStubOverrides = Partial<{
  customers: Partial<Record<string, AsyncFn>> & { listIterator?: () => AsyncIterableIterator<any> }
  subscriptions: Partial<Record<string, AsyncFn>>
  subscriptionItems: Partial<Record<string, AsyncFn>>
  prices: Partial<Record<string, AsyncFn>>
  products: Partial<Record<string, AsyncFn>>
  invoices: Partial<Record<string, AsyncFn>>
  invoiceItems: Partial<Record<string, AsyncFn>>
  charges: Partial<Record<string, AsyncFn>>
  paymentIntents: Partial<Record<string, AsyncFn>>
  paymentMethods: Partial<Record<string, AsyncFn>>
  checkoutSessions: Partial<Record<string, AsyncFn>>
  billingPortalSessions: Partial<Record<string, AsyncFn>>
  meterEvents: Partial<Record<string, AsyncFn>>
  refunds: Partial<Record<string, AsyncFn>>
  setupIntents: Partial<Record<string, AsyncFn>>
  taxRates: Partial<Record<string, AsyncFn>>
  webhooks: Partial<Record<string, AsyncFn>>
  events: Partial<Record<string, AsyncFn>>
  accounts: Partial<Record<string, AsyncFn>>
  accountLinks: Partial<Record<string, AsyncFn>>
  payouts: Partial<Record<string, AsyncFn>>
  transfers: Partial<Record<string, AsyncFn>>
}>

export function makeStripeStub(overrides: StripeStubOverrides = {}): any {
  function r(group: keyof StripeStubOverrides, defaults: Record<string, AsyncFn>): any {
    const ov = (overrides[group] ?? {}) as Record<string, AsyncFn>
    return { ...defaults, ...ov }
  }
  return {
    customers: r('customers', {
      retrieve: asyncEmpty(),
      create: asyncEmpty(),
      update: asyncEmpty(),
      list: asyncList(),
      del: asyncEmpty(),
      search: asyncList(),
    }),
    subscriptions: r('subscriptions', {
      retrieve: asyncEmpty(),
      create: asyncEmpty(),
      update: asyncEmpty(),
      cancel: asyncEmpty(),
      del: asyncEmpty(),
      list: asyncList(),
    }),
    subscriptionItems: r('subscriptionItems', {
      retrieve: asyncEmpty(),
      create: asyncEmpty(),
      update: asyncEmpty(),
      del: asyncEmpty(),
      list: asyncList(),
      listUsageRecordSummaries: asyncList(),
      createUsageRecord: asyncEmpty(),
    }),
    prices: r('prices', { retrieve: asyncEmpty(), create: asyncEmpty(), list: asyncList(), search: asyncList() }),
    products: r('products', { retrieve: asyncEmpty(), create: asyncEmpty(), list: asyncList() }),
    invoices: r('invoices', {
      retrieve: asyncEmpty(),
      create: asyncEmpty(),
      finalizeInvoice: asyncEmpty(),
      pay: asyncEmpty(),
      list: asyncList(),
      retrieveUpcoming: asyncEmpty(),
    }),
    invoiceItems: r('invoiceItems', { create: asyncEmpty(), list: asyncList(), del: asyncEmpty() }),
    charges: r('charges', { retrieve: asyncEmpty(), list: asyncList() }),
    paymentIntents: r('paymentIntents', { retrieve: asyncEmpty(), create: asyncEmpty(), confirm: asyncEmpty(), cancel: asyncEmpty() }),
    paymentMethods: r('paymentMethods', { retrieve: asyncEmpty(), attach: asyncEmpty(), list: asyncList(), detach: asyncEmpty() }),
    checkout: { sessions: r('checkoutSessions', { create: asyncEmpty(), retrieve: asyncEmpty() }) },
    billingPortal: { sessions: r('billingPortalSessions', { create: asyncEmpty() }) },
    billing: {
      meterEvents: r('meterEvents', { create: asyncEmpty() }),
      meterEventSummaries: { list: asyncList() },
    },
    refunds: r('refunds', { create: asyncEmpty(), retrieve: asyncEmpty() }),
    setupIntents: r('setupIntents', { create: asyncEmpty(), retrieve: asyncEmpty(), confirm: asyncEmpty() }),
    taxRates: r('taxRates', { list: asyncList() }),
    webhooks: r('webhooks', {
      // `constructEvent` is sync in the real SDK.
      constructEvent: (async (raw: any) => ({ type: 'test.event', data: { object: {} }, id: 'evt_test' })) as AsyncFn,
    } as any),
    events: r('events', { retrieve: asyncEmpty(), list: asyncList() }),
    accounts: r('accounts', { create: asyncEmpty(), retrieve: asyncEmpty(), update: asyncEmpty(), del: asyncEmpty() }),
    accountLinks: r('accountLinks', { create: asyncEmpty() }),
    payouts: r('payouts', { list: asyncList(), retrieve: asyncEmpty() }),
    transfers: r('transfers', { create: asyncEmpty() }),
  }
}

/**
 * Returns a `mock.module('stripe', ...)` factory result. The real SDK
 * is imported as `import Stripe from 'stripe'`, so the `default` field
 * must be a constructor that returns our stub.
 */
export function withStripeExports(stripe: any = makeStripeStub()): any {
  class StripeCtor {
    constructor() { return stripe }
    static Webhook = stripe.webhooks
    static errors = {
      StripeError: class StripeError extends Error {},
      StripeCardError: class StripeCardError extends Error {},
      StripeInvalidRequestError: class StripeInvalidRequestError extends Error {},
      StripeAPIError: class StripeAPIError extends Error {},
      StripeAuthenticationError: class StripeAuthenticationError extends Error {},
      StripeConnectionError: class StripeConnectionError extends Error {},
      StripePermissionError: class StripePermissionError extends Error {},
      StripeRateLimitError: class StripeRateLimitError extends Error {},
      StripeSignatureVerificationError: class StripeSignatureVerificationError extends Error {},
    }
  }
  return { default: StripeCtor, Stripe: StripeCtor }
}
