// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ---- prisma mock ----
type Profile = {
  id: string
  stripeCustomAccountId: string | null
  payoutStatus?: string
  payoutDetailsSubmittedAt?: Date
}
const profiles = new Map<string, Profile>()

mock.module('../../lib/prisma', () => ({
  prisma: {
    creatorProfile: {
      findUnique: async ({ where }: any) => profiles.get(where.id) ?? null,
      findFirst: async ({ where }: any) => {
        for (const p of profiles.values()) {
          if (p.stripeCustomAccountId === where.stripeCustomAccountId) return p
        }
        return null
      },
      update: async ({ where, data }: any) => {
        const p = profiles.get(where.id)
        if (!p) throw new Error('not found')
        Object.assign(p, data)
        return p
      },
    },
  },
  PayoutStatus: {
    pending_verification: 'pending_verification',
    verified: 'verified',
    disabled: 'disabled',
    requires_update: 'requires_update',
  },
}))

// ---- stripe mock ----
type StripeCall = { method: string; args: any[] }
const stripeCalls: StripeCall[] = []
let nextAccountCreate: any = { id: 'acct_default' }
let nextAccountRetrieve: any = {}
let nextCheckout: any = { url: 'https://checkout.stripe.com/c/pay/sess_xyz' }
let nextSubscriptionCheckout: any = { url: 'https://checkout.stripe.com/c/pay/sub_xyz' }
let nextBalance: any = { available: [{ currency: 'usd', amount: 10000 }] }
let nextPayout: any = { id: 'po_real' }
let nextAccountUpdate: any = {}
let nextThrow: { method: string; err: any } | null = null

class FakeStripe {
  constructor(public secret: string, public opts: any) {}
  accounts = {
    create: async (args: any) => {
      stripeCalls.push({ method: 'accounts.create', args: [args] })
      if (nextThrow?.method === 'accounts.create') { const e = nextThrow.err; nextThrow = null; throw e }
      return nextAccountCreate
    },
    update: async (id: string, args: any) => {
      stripeCalls.push({ method: 'accounts.update', args: [id, args] })
      return nextAccountUpdate
    },
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'accounts.retrieve', args: [id] })
      return nextAccountRetrieve
    },
  }
  checkout = {
    sessions: {
      create: async (args: any) => {
        stripeCalls.push({ method: 'checkout.sessions.create', args: [args] })
        if (args.mode === 'subscription') return nextSubscriptionCheckout
        return nextCheckout
      },
    },
  }
  balance = {
    retrieve: async (args: any) => {
      stripeCalls.push({ method: 'balance.retrieve', args: [args] })
      return nextBalance
    },
  }
  payouts = {
    create: async (args: any, opts: any) => {
      stripeCalls.push({ method: 'payouts.create', args: [args, opts] })
      return nextPayout
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe }))

const sc = await import('../stripe-connect.service')

beforeEach(() => {
  profiles.clear()
  stripeCalls.length = 0
  nextAccountCreate = { id: 'acct_created' }
  nextAccountRetrieve = {}
  nextCheckout = { url: 'https://checkout.stripe.com/sess' }
  nextSubscriptionCheckout = { url: 'https://checkout.stripe.com/sub' }
  nextBalance = { available: [{ currency: 'usd', amount: 10000 }] }
  nextPayout = { id: 'po_real_1' }
  nextAccountUpdate = {}
  nextThrow = null
  // Default: Stripe is configured for tests that want the live path
  process.env.STRIPE_SECRET_KEY = 'sk_test_123'
})

afterEach(() => {
  delete (process.env as any).STRIPE_SECRET_KEY
})

const baseDetails = {
  firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.io',
  dob: { day: 10, month: 12, year: 1815 },
  address: { line1: '1 St', city: 'London', state: 'EN', postal_code: 'W1', country: 'GB' },
}

describe('PLATFORM_FEE_PERCENT', () => {
  it('is exported as 20', () => {
    expect(sc.PLATFORM_FEE_PERCENT).toBe(20)
  })
})

describe('createCustomAccount', () => {
  it('throws when creator profile is missing', async () => {
    await expect(sc.createCustomAccount('nope', 'a@b.c')).rejects.toThrow(/not found/)
  })

  it('returns existing stripeCustomAccountId when set', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_existing' })
    expect(await sc.createCustomAccount('c1', 'a@b.c')).toBe('acct_existing')
    expect(stripeCalls).toHaveLength(0)
  })

  it('creates a Stripe account, persists id, returns it (configured)', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: null })
    nextAccountCreate = { id: 'acct_new' }
    const r = await sc.createCustomAccount('c1', 'me@x.io', 'CA')
    expect(r).toBe('acct_new')
    expect(profiles.get('c1')?.stripeCustomAccountId).toBe('acct_new')
    const args = stripeCalls[0].args[0]
    expect(args.type).toBe('custom')
    expect(args.country).toBe('CA')
    expect(args.email).toBe('me@x.io')
    expect(args.capabilities.transfers.requested).toBe(true)
    expect(args.settings.payouts.schedule.interval).toBe('manual')
  })

  it('uses default country US when not provided', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: null })
    nextAccountCreate = { id: 'acct_us' }
    await sc.createCustomAccount('c1', 'e@x.io')
    expect(stripeCalls[0].args[0].country).toBe('US')
  })

  it('returns a mock id and persists when Stripe is NOT configured', async () => {
    delete (process.env as any).STRIPE_SECRET_KEY
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: null })
    const r = await sc.createCustomAccount('c1', 'e@x.io')
    expect(r).toMatch(/^acct_mock_/)
    expect(profiles.get('c1')?.stripeCustomAccountId).toBe(r)
    expect(stripeCalls).toHaveLength(0)
  })
})

describe('submitPayoutDetails', () => {
  it('throws when profile has no Stripe account', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: null })
    await expect(sc.submitPayoutDetails('c1', baseDetails)).rejects.toThrow(/no Stripe Connect/)
  })

  it('updates DB only when Stripe is unconfigured (no API call)', async () => {
    delete (process.env as any).STRIPE_SECRET_KEY
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    await sc.submitPayoutDetails('c1', baseDetails)
    expect(profiles.get('c1')?.payoutStatus).toBe('pending_verification')
    expect(stripeCalls).toHaveLength(0)
  })

  it('calls Stripe accounts.update with individual + DB transition', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    await sc.submitPayoutDetails('c1', { ...baseDetails, ssnLast4: '1234', bankAccountToken: 'btok_1' })
    expect(stripeCalls[0].method).toBe('accounts.update')
    const [id, params] = stripeCalls[0].args
    expect(id).toBe('acct_x')
    expect(params.individual.first_name).toBe('Ada')
    expect(params.individual.ssn_last_4).toBe('1234')
    expect(params.external_account).toBe('btok_1')
    expect(profiles.get('c1')?.payoutStatus).toBe('pending_verification')
  })

  it('omits ssn_last_4 + external_account when not provided', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    await sc.submitPayoutDetails('c1', baseDetails)
    const params = stripeCalls[0].args[1]
    expect(params.individual.ssn_last_4).toBeUndefined()
    expect(params.external_account).toBeUndefined()
  })
})

describe('getAccountStatus', () => {
  it('throws when profile has no Stripe account', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: null })
    await expect(sc.getAccountStatus('c1')).rejects.toThrow(/no Stripe Connect/)
  })

  it('returns full-access shape when Stripe is unconfigured', async () => {
    delete (process.env as any).STRIPE_SECRET_KEY
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    const r = await sc.getAccountStatus('c1')
    expect(r).toEqual({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requiresAction: false,
      currentlyDue: [],
    })
  })

  it('reads charges/payouts/details flags from Stripe', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    nextAccountRetrieve = {
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [], past_due: [] },
    }
    const r = await sc.getAccountStatus('c1')
    expect(r.chargesEnabled).toBe(true)
    expect(r.payoutsEnabled).toBe(true)
    expect(r.requiresAction).toBe(false)
  })

  it('flags requiresAction when currently_due is non-empty', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    nextAccountRetrieve = {
      charges_enabled: false, payouts_enabled: false, details_submitted: false,
      requirements: { currently_due: ['external_account'], past_due: [] },
    }
    const r = await sc.getAccountStatus('c1')
    expect(r.requiresAction).toBe(true)
    expect(r.currentlyDue).toEqual(['external_account'])
  })

  it('flags requiresAction when past_due is non-empty', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    nextAccountRetrieve = {
      requirements: { currently_due: [], past_due: ['individual.dob'] },
    }
    expect((await sc.getAccountStatus('c1')).requiresAction).toBe(true)
  })

  it('handles missing requirements object', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    nextAccountRetrieve = {}
    const r = await sc.getAccountStatus('c1')
    expect(r.requiresAction).toBe(false)
    expect(r.currentlyDue).toEqual([])
  })
})

describe('handleAccountUpdated', () => {
  it('no-ops silently when Stripe is unconfigured', async () => {
    delete (process.env as any).STRIPE_SECRET_KEY
    await sc.handleAccountUpdated('acct_x')
    expect(stripeCalls).toHaveLength(0)
  })

  it('no-ops when no profile maps to the account id', async () => {
    await sc.handleAccountUpdated('acct_unknown')
    expect(stripeCalls).toHaveLength(0)
  })

  it('maps payouts_enabled+details_submitted → verified', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_y' })
    nextAccountRetrieve = { payouts_enabled: true, details_submitted: true, requirements: {} }
    await sc.handleAccountUpdated('acct_y')
    expect(profiles.get('c1')?.payoutStatus).toBe('verified')
  })

  it('maps disabled_reason → disabled', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_y' })
    nextAccountRetrieve = { requirements: { disabled_reason: 'fields_needed' } }
    await sc.handleAccountUpdated('acct_y')
    expect(profiles.get('c1')?.payoutStatus).toBe('disabled')
  })

  it('maps currently_due/past_due → requires_update', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_y' })
    nextAccountRetrieve = { requirements: { currently_due: ['x'], past_due: [] } }
    await sc.handleAccountUpdated('acct_y')
    expect(profiles.get('c1')?.payoutStatus).toBe('requires_update')
  })

  it('falls through to pending_verification', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_y' })
    nextAccountRetrieve = { requirements: {} }
    await sc.handleAccountUpdated('acct_y')
    expect(profiles.get('c1')?.payoutStatus).toBe('pending_verification')
  })
})

describe('createCheckoutSession', () => {
  it('returns success URL when Stripe is unconfigured (no API call)', async () => {
    delete (process.env as any).STRIPE_SECRET_KEY
    const url = await sc.createCheckoutSession({
      listingId: 'l1', buyerEmail: 'b@x.io', priceInCents: 1000,
      creatorStripeAccountId: 'acct_c', successUrl: 'https://ok', cancelUrl: 'https://no',
    })
    expect(url).toBe('https://ok')
    expect(stripeCalls).toHaveLength(0)
  })

  it('throws when platform fee >= charge amount', async () => {
    await expect(
      sc.createCheckoutSession({
        listingId: 'l1', buyerEmail: 'b@x.io', priceInCents: 0,
        creatorStripeAccountId: 'acct_c', successUrl: 'https://ok', cancelUrl: 'https://no',
      }),
    ).rejects.toThrow(/Platform fee must be less than/)
  })

  it('throws when Stripe returns no session url', async () => {
    nextCheckout = {}
    await expect(
      sc.createCheckoutSession({
        listingId: 'l1', buyerEmail: 'b@x.io', priceInCents: 10000,
        creatorStripeAccountId: 'acct_c', successUrl: 'https://ok', cancelUrl: 'https://no',
      }),
    ).rejects.toThrow(/no URL/)
  })

  it('builds session with 20% fee + destination transfer + metadata merge', async () => {
    nextCheckout = { url: 'https://sess' }
    const url = await sc.createCheckoutSession({
      listingId: 'l1', buyerEmail: 'b@x.io', priceInCents: 10000,
      creatorStripeAccountId: 'acct_c', successUrl: 'https://ok', cancelUrl: 'https://no',
      metadata: { campaign: 'spring' },
    })
    expect(url).toBe('https://sess')
    const args = stripeCalls[0].args[0]
    expect(args.mode).toBe('payment')
    expect(args.line_items[0].price_data.unit_amount).toBe(10000)
    expect(args.payment_intent_data.application_fee_amount).toBe(2000)
    expect(args.payment_intent_data.transfer_data.destination).toBe('acct_c')
    expect(args.metadata).toEqual({ listingId: 'l1', campaign: 'spring' })
  })
})

describe('createSubscriptionCheckout', () => {
  it('returns success URL when Stripe is unconfigured', async () => {
    delete (process.env as any).STRIPE_SECRET_KEY
    expect(
      await sc.createSubscriptionCheckout({
        listingId: 'l1', buyerEmail: 'b@x.io', stripePriceId: 'price_x',
        creatorStripeAccountId: 'acct_c', successUrl: 'https://ok', cancelUrl: 'https://no',
      }),
    ).toBe('https://ok')
  })

  it('builds subscription session with 20% application_fee_percent', async () => {
    nextSubscriptionCheckout = { url: 'https://sub' }
    const url = await sc.createSubscriptionCheckout({
      listingId: 'l1', buyerEmail: 'b@x.io', stripePriceId: 'price_x',
      creatorStripeAccountId: 'acct_c', successUrl: 'https://ok', cancelUrl: 'https://no',
    })
    expect(url).toBe('https://sub')
    const args = stripeCalls[0].args[0]
    expect(args.mode).toBe('subscription')
    expect(args.subscription_data.application_fee_percent).toBe(20)
    expect(args.subscription_data.transfer_data.destination).toBe('acct_c')
  })

  it('throws when Stripe returns no session URL', async () => {
    nextSubscriptionCheckout = {}
    await expect(
      sc.createSubscriptionCheckout({
        listingId: 'l1', buyerEmail: 'b@x.io', stripePriceId: 'p',
        creatorStripeAccountId: 'acct_c', successUrl: 'https://ok', cancelUrl: 'https://no',
      }),
    ).rejects.toThrow(/no URL/)
  })
})

describe('triggerPayout', () => {
  it('throws when profile has no Stripe account', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: null })
    await expect(sc.triggerPayout('c1')).rejects.toThrow(/no Stripe Connect/)
  })

  it('returns a mock payout id when Stripe is unconfigured', async () => {
    delete (process.env as any).STRIPE_SECRET_KEY
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    const id = await sc.triggerPayout('c1')
    expect(id).toMatch(/^po_mock_/)
    expect(stripeCalls).toHaveLength(0)
  })

  it('uses full USD balance when no amount provided', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    nextBalance = { available: [{ currency: 'usd', amount: 5000 }] }
    nextPayout = { id: 'po_full' }
    const id = await sc.triggerPayout('c1')
    expect(id).toBe('po_full')
    const payoutCall = stripeCalls.find((c) => c.method === 'payouts.create')!
    expect(payoutCall.args[0]).toEqual({ amount: 5000, currency: 'usd' })
    expect(payoutCall.args[1]).toEqual({ stripeAccount: 'acct_x' })
  })

  it('handles explicit amount within balance', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    nextBalance = { available: [{ currency: 'usd', amount: 1000 }] }
    await sc.triggerPayout('c1', 500)
    const args = stripeCalls.find((c) => c.method === 'payouts.create')!.args[0]
    expect(args.amount).toBe(500)
  })

  it('throws when amount <= 0', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    nextBalance = { available: [{ currency: 'usd', amount: 0 }] }
    await expect(sc.triggerPayout('c1')).rejects.toThrow(/No amount available/)
  })

  it('throws when amount exceeds balance', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    nextBalance = { available: [{ currency: 'usd', amount: 100 }] }
    await expect(sc.triggerPayout('c1', 500)).rejects.toThrow(/exceeds available/)
  })

  it('treats missing USD bucket as zero balance', async () => {
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: 'acct_x' })
    nextBalance = { available: [{ currency: 'eur', amount: 5000 }] }
    await expect(sc.triggerPayout('c1')).rejects.toThrow(/No amount available/)
  })
})

describe('getAccountBalance', () => {
  it('returns 0 when Stripe is unconfigured', async () => {
    delete (process.env as any).STRIPE_SECRET_KEY
    expect(await sc.getAccountBalance('acct_x')).toBe(0)
  })

  it('returns USD bucket amount', async () => {
    nextBalance = { available: [{ currency: 'usd', amount: 7777 }] }
    expect(await sc.getAccountBalance('acct_x')).toBe(7777)
  })

  it('falls back to first available bucket when no USD', async () => {
    nextBalance = { available: [{ currency: 'eur', amount: 2222 }] }
    expect(await sc.getAccountBalance('acct_x')).toBe(2222)
  })

  it('returns 0 when available array is empty', async () => {
    nextBalance = { available: [] }
    expect(await sc.getAccountBalance('acct_x')).toBe(0)
  })
})

describe('Stripe configuration', () => {
  it('lazily instantiates Stripe SDK with apiVersion + secret key', async () => {
    // First call against a configured profile triggers getStripe() init
    profiles.set('c1', { id: 'c1', stripeCustomAccountId: null })
    await sc.createCustomAccount('c1', 'me@x.io')
    // Second call should reuse the instance (no new construction)
    profiles.set('c2', { id: 'c2', stripeCustomAccountId: null })
    nextAccountCreate = { id: 'acct_c2' }
    await sc.createCustomAccount('c2', 'me2@x.io')
    expect(stripeCalls.filter((c) => c.method === 'accounts.create')).toHaveLength(2)
  })

  it('throws "Stripe is not configured" when getStripe() is reached with STRIPE_SECRET_KEY unset', () => {
    // Every public caller pre-checks isStripeConfigured() before reaching
    // getStripe(), so the guard inside getStripe() is unreachable from the
    // public API. __getStripeForTesting() lets us drive the singleton init
    // path directly to cover the "not configured" throw.
    sc.__resetStripeInstanceForTesting()
    const saved = process.env.STRIPE_SECRET_KEY
    delete (process.env as any).STRIPE_SECRET_KEY
    try {
      expect(() => sc.__getStripeForTesting()).toThrow(
        'Stripe is not configured (STRIPE_SECRET_KEY not set)',
      )
    } finally {
      if (saved !== undefined) process.env.STRIPE_SECRET_KEY = saved
      sc.__resetStripeInstanceForTesting()
    }
  })

  it('memoizes the Stripe singleton across __getStripeForTesting() calls', () => {
    sc.__resetStripeInstanceForTesting()
    process.env.STRIPE_SECRET_KEY = 'sk_test_singleton'
    try {
      const a = sc.__getStripeForTesting()
      const b = sc.__getStripeForTesting()
      expect(a).toBe(b)
    } finally {
      sc.__resetStripeInstanceForTesting()
    }
  })
})
