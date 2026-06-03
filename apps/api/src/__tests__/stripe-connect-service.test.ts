// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/services/stripe-connect.service.ts`.
 *
 * Covers every exported function in both configured and unconfigured-Stripe
 * modes:
 *   - createCustomAccount (already-linked / mock-mode / live)
 *   - submitPayoutDetails (mock-mode / live with + without bankToken/ssn)
 *   - getAccountStatus (mock-mode default / live requirements due / past_due)
 *   - handleAccountUpdated (no Stripe / no profile / all derivation branches)
 *   - createCheckoutSession (no Stripe shortcut / fee guard / live)
 *   - createSubscriptionCheckout (no Stripe / live / missing session.url)
 *   - triggerPayout (no profile / mock / no balance / over-balance / live)
 *   - getAccountBalance (no Stripe / usd / fallback first row)
 *
 * Stripe and Prisma are both replaced with hand-rolled stubs.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports, PRISMA_NAMESPACE } from './helpers/prisma-mock-exports'

// ─── In-memory Prisma ─────────────────────────────────────────────────

let profiles: Map<string, any>
function resetStores() {
  profiles = new Map()
}
resetStores()

const creatorProfileTable = {
  findUnique: async (args: any) => profiles.get(args.where.id) ?? null,
  findFirst: async (args: any) => {
    for (const p of profiles.values()) {
      if (args.where.stripeCustomAccountId === p.stripeCustomAccountId) return p
    }
    return null
  },
  update: async (args: any) => {
    const existing = profiles.get(args.where.id)
    if (!existing) throw new Error('not found')
    const merged = { ...existing, ...args.data }
    profiles.set(args.where.id, merged)
    return merged
  },
}

const PAYOUT_STATUS = {
  pending_verification: 'pending_verification',
  verified: 'verified',
  disabled: 'disabled',
  requires_update: 'requires_update',
}

mock.module('../lib/prisma', () =>
  withPrismaExports({
    prisma: { creatorProfile: creatorProfileTable },
    Prisma: PRISMA_NAMESPACE,
  }),
)

// The service imports `PayoutStatus` from `../lib/prisma`. `withPrismaExports`
// only ships the billing enums; layer PayoutStatus on top by overriding the
// factory return.
mock.module('../lib/prisma', () => ({
  ...withPrismaExports({ prisma: { creatorProfile: creatorProfileTable } }),
  PayoutStatus: PAYOUT_STATUS,
}))

// ─── Stripe mock ──────────────────────────────────────────────────────

let accountsCreateImpl = async (_p: any) => ({ id: 'acct_new' })
let accountsRetrieveImpl = async (_id: string) => ({
  charges_enabled: false,
  payouts_enabled: false,
  details_submitted: false,
  requirements: { currently_due: [], past_due: [], disabled_reason: null },
})
const accountsUpdateSpy = mock(async (_id: string, _p: any) => ({ id: 'acct_updated' }))
const accountLinksCreateSpy = mock(async (_p: any) => ({
  url: 'https://connect.stripe.com/setup/c/acct_live/abc',
}))
let checkoutCreateImpl: (params: any) => Promise<any> = async () => ({
  url: 'https://checkout/x',
})
let balanceRetrieveImpl = async (_opts: any) => ({
  available: [{ amount: 0, currency: 'usd' }],
})
let payoutsCreateImpl = async (_p: any, _o: any) => ({ id: 'po_live_1' })

class FakeStripe {
  accounts = {
    create: (p: any) => accountsCreateImpl(p),
    retrieve: (id: string) => accountsRetrieveImpl(id),
    update: (id: string, p: any) => accountsUpdateSpy(id, p),
  }
  accountLinks = {
    create: (p: any) => accountLinksCreateSpy(p),
  }
  checkout = {
    sessions: { create: (p: any) => checkoutCreateImpl(p) },
  }
  balance = { retrieve: (o: any) => balanceRetrieveImpl(o) }
  payouts = { create: (p: any, o: any) => payoutsCreateImpl(p, o) }

  constructor(_key: string, _cfg: any) {}
}

mock.module('stripe', () => ({ default: FakeStripe }))

// Import service AFTER mocks (also enable Stripe by setting key)
process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
const svc = await import('../services/stripe-connect.service')

beforeEach(() => {
  resetStores()
  accountsCreateImpl = async (_p: any) => ({ id: 'acct_new' })
  accountsRetrieveImpl = async (_id: string) => ({
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
    requirements: { currently_due: [], past_due: [], disabled_reason: null },
  })
  accountsUpdateSpy.mockClear()
  accountLinksCreateSpy.mockClear()
  accountLinksCreateSpy.mockImplementation(async (_p: any) => ({
    url: 'https://connect.stripe.com/setup/c/acct_live/abc',
  }))
  checkoutCreateImpl = async () => ({ url: 'https://checkout/x' })
  balanceRetrieveImpl = async (_o: any) => ({
    available: [{ amount: 0, currency: 'usd' }],
  })
  payoutsCreateImpl = async (_p: any, _o: any) => ({ id: 'po_live_1' })
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
})

afterEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
})

// ──────────────────────────────────────────────────────────────────────
// createCustomAccount
// ──────────────────────────────────────────────────────────────────────

describe('createCustomAccount', () => {
  test('throws when creator profile not found', async () => {
    await expect(svc.createCustomAccount('cp_missing', 'a@b.c')).rejects.toThrow(
      'Creator profile not found',
    )
  })

  test('returns existing stripeCustomAccountId if already linked', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_existing' })
    expect(await svc.createCustomAccount('cp_1', 'a@b.c')).toBe('acct_existing')
  })

  test('returns acct_mock_* when Stripe is not configured (no key)', async () => {
    delete process.env.STRIPE_SECRET_KEY
    profiles.set('cp_2longerid12345', { id: 'cp_2longerid12345' })
    const id = await svc.createCustomAccount('cp_2longerid12345', 'x@y.z')
    expect(id).toMatch(/^acct_mock_/)
    expect(profiles.get('cp_2longerid12345').stripeCustomAccountId).toBe(id)
  })

  test('calls Stripe and persists returned account id when configured', async () => {
    profiles.set('cp_3', { id: 'cp_3' })
    accountsCreateImpl = async (_p: any) => ({ id: 'acct_real_xyz' })
    const id = await svc.createCustomAccount('cp_3', 'e@e.e', 'US')
    expect(id).toBe('acct_real_xyz')
    expect(profiles.get('cp_3').stripeCustomAccountId).toBe('acct_real_xyz')
  })
})

// ──────────────────────────────────────────────────────────────────────
// submitPayoutDetails
// ──────────────────────────────────────────────────────────────────────

const SAMPLE_DETAILS = {
  firstName: 'A',
  lastName: 'B',
  email: 'a@b.c',
  dob: { day: 1, month: 1, year: 1990 },
  address: {
    line1: '1 St',
    city: 'X',
    state: 'CA',
    postal_code: '90000',
    country: 'US',
  },
}

describe('submitPayoutDetails', () => {
  test('self-heals by creating a Connect account when one is missing', async () => {
    // Post-merge behaviour: rather than rejecting when the Connect account was
    // never provisioned, submitPayoutDetails now creates it on the fly. In
    // mock mode (no STRIPE_SECRET_KEY) createCustomAccount mints acct_mock_<id>.
    delete process.env.STRIPE_SECRET_KEY
    profiles.set('cp_1', { id: 'cp_1' })
    await svc.submitPayoutDetails('cp_1', SAMPLE_DETAILS)
    const p = profiles.get('cp_1')
    expect(p.stripeCustomAccountId).toBe('acct_mock_cp_1')
    expect(p.payoutStatus).toBe('pending_verification')
  })

  test('mock mode: marks pending_verification without calling Stripe', async () => {
    delete process.env.STRIPE_SECRET_KEY
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_mock_1' })
    await svc.submitPayoutDetails('cp_1', SAMPLE_DETAILS)
    expect(profiles.get('cp_1').payoutStatus).toBe('pending_verification')
    expect(profiles.get('cp_1').payoutDetailsSubmittedAt).toBeInstanceOf(Date)
    expect(accountsUpdateSpy).not.toHaveBeenCalled()
  })

  test('live: includes ssn + external_account when supplied', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_live' })
    await svc.submitPayoutDetails('cp_1', {
      ...SAMPLE_DETAILS,
      ssnLast4: '1234',
      bankAccountToken: 'btok_x',
    })
    expect(accountsUpdateSpy).toHaveBeenCalledTimes(1)
    const [acctId, params] = accountsUpdateSpy.mock.calls[0]
    expect(acctId).toBe('acct_live')
    expect(params.individual.ssn_last_4).toBe('1234')
    expect(params.external_account).toBe('btok_x')
  })

  test('live: omits ssn + external_account when not supplied', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_live' })
    await svc.submitPayoutDetails('cp_1', SAMPLE_DETAILS)
    const params = accountsUpdateSpy.mock.calls[0][1]
    expect(params.individual.ssn_last_4).toBeUndefined()
    expect(params.external_account).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────────
// createOnboardingLink
// ──────────────────────────────────────────────────────────────────────

describe('createOnboardingLink', () => {
  const URLS = {
    refreshUrl: 'https://app.test/marketplace/creator/payout-setup?refresh=1',
    returnUrl: 'https://app.test/marketplace/creator/payout-setup?return=1',
  }

  test('throws when profile has no stripe account id', async () => {
    profiles.set('cp_1', { id: 'cp_1' })
    await expect(svc.createOnboardingLink('cp_1', URLS)).rejects.toThrow(
      'Creator has no Stripe Connect account',
    )
  })

  test('throws when profile is missing entirely', async () => {
    await expect(svc.createOnboardingLink('cp_missing', URLS)).rejects.toThrow(
      'Creator has no Stripe Connect account',
    )
  })

  test('mock mode: returns returnUrl without hitting Stripe', async () => {
    delete process.env.STRIPE_SECRET_KEY
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_mock_1' })
    const res = await svc.createOnboardingLink('cp_1', URLS)
    expect(res.url).toBe(URLS.returnUrl)
    expect(accountLinksCreateSpy).not.toHaveBeenCalled()
  })

  test('live: forwards account + URLs to Stripe and returns link url', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_live' })
    const res = await svc.createOnboardingLink('cp_1', URLS)
    expect(accountLinksCreateSpy).toHaveBeenCalledTimes(1)
    const params = accountLinksCreateSpy.mock.calls[0][0]
    expect(params.account).toBe('acct_live')
    expect(params.refresh_url).toBe(URLS.refreshUrl)
    expect(params.return_url).toBe(URLS.returnUrl)
    expect(params.type).toBe('account_onboarding')
    expect(res.url).toBe('https://connect.stripe.com/setup/c/acct_live/abc')
  })
})

// ──────────────────────────────────────────────────────────────────────
// getAccountStatus
// ──────────────────────────────────────────────────────────────────────

describe('getAccountStatus', () => {
  test('throws when profile has no stripe account', async () => {
    profiles.set('cp_1', { id: 'cp_1' })
    await expect(svc.getAccountStatus('cp_1')).rejects.toThrow(
      'Creator has no Stripe Connect account',
    )
  })

  test('mock mode: returns happy-path payload', async () => {
    delete process.env.STRIPE_SECRET_KEY
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_mock_1' })
    const s = await svc.getAccountStatus('cp_1')
    expect(s).toEqual({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requiresAction: false,
      currentlyDue: [],
    })
  })

  test('live: requiresAction=true when currently_due has entries', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_live' })
    accountsRetrieveImpl = async () => ({
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      requirements: { currently_due: ['external_account'], past_due: [] },
    })
    const s = await svc.getAccountStatus('cp_1')
    expect(s.chargesEnabled).toBe(true)
    expect(s.payoutsEnabled).toBe(false)
    expect(s.requiresAction).toBe(true)
    expect(s.currentlyDue).toEqual(['external_account'])
  })

  test('live: requiresAction=true when only past_due has entries', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_live' })
    accountsRetrieveImpl = async () => ({
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements: { currently_due: [], past_due: ['tax_id'] },
    })
    const s = await svc.getAccountStatus('cp_1')
    expect(s.requiresAction).toBe(true)
    expect(s.currentlyDue).toEqual([])
  })

  test('live: handles missing requirements field gracefully', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_live' })
    accountsRetrieveImpl = async () => ({
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: undefined,
    })
    const s = await svc.getAccountStatus('cp_1')
    expect(s.requiresAction).toBe(false)
    expect(s.currentlyDue).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────
// handleAccountUpdated
// ──────────────────────────────────────────────────────────────────────

describe('handleAccountUpdated', () => {
  test('no-op when Stripe not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_x', payoutStatus: 'verified' })
    await svc.handleAccountUpdated('acct_x')
    expect(profiles.get('cp_1').payoutStatus).toBe('verified')
  })

  test('no-op when no matching profile', async () => {
    await svc.handleAccountUpdated('acct_ghost')
    expect(profiles.size).toBe(0)
  })

  test('derives verified when payouts_enabled && details_submitted', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_x', payoutStatus: 'pending_verification' })
    accountsRetrieveImpl = async () => ({
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [], past_due: [], disabled_reason: null },
    })
    await svc.handleAccountUpdated('acct_x')
    expect(profiles.get('cp_1').payoutStatus).toBe('verified')
  })

  test('derives disabled when disabled_reason set', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_x' })
    accountsRetrieveImpl = async () => ({
      payouts_enabled: false,
      details_submitted: true,
      requirements: { currently_due: [], past_due: [], disabled_reason: 'fraud' },
    })
    await svc.handleAccountUpdated('acct_x')
    expect(profiles.get('cp_1').payoutStatus).toBe('disabled')
  })

  test('derives requires_update when currently_due or past_due > 0', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_x' })
    accountsRetrieveImpl = async () => ({
      payouts_enabled: false,
      details_submitted: false,
      requirements: { currently_due: ['x'], past_due: [], disabled_reason: null },
    })
    await svc.handleAccountUpdated('acct_x')
    expect(profiles.get('cp_1').payoutStatus).toBe('requires_update')
  })

  test('derives pending_verification as fallback', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_x' })
    accountsRetrieveImpl = async () => ({
      payouts_enabled: false,
      details_submitted: false,
      requirements: { currently_due: [], past_due: [], disabled_reason: null },
    })
    await svc.handleAccountUpdated('acct_x')
    expect(profiles.get('cp_1').payoutStatus).toBe('pending_verification')
  })
})

// ──────────────────────────────────────────────────────────────────────
// createCheckoutSession
// ──────────────────────────────────────────────────────────────────────

const CHECKOUT_BASE = {
  listingId: 'lst_1',
  buyerEmail: 'b@u.y',
  priceInCents: 5000,
  creatorStripeAccountId: 'acct_seller',
  successUrl: 'https://ok',
  cancelUrl: 'https://no',
}

describe('createCheckoutSession', () => {
  test('returns successUrl shortcut when Stripe not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY
    expect(await svc.createCheckoutSession(CHECKOUT_BASE)).toBe('https://ok')
  })

  test('throws when fee >= price (price=0 → fee=0)', async () => {
    await expect(
      svc.createCheckoutSession({ ...CHECKOUT_BASE, priceInCents: 0 }),
    ).rejects.toThrow('Platform fee must be less than charge amount')
  })

  test('creates session with 20% application fee and returns its url', async () => {
    let captured: any
    checkoutCreateImpl = async (p: any) => {
      captured = p
      return { url: 'https://stripe/session-1' }
    }
    const url = await svc.createCheckoutSession(CHECKOUT_BASE)
    expect(url).toBe('https://stripe/session-1')
    expect(captured.payment_intent_data.application_fee_amount).toBe(1000)
    expect(captured.payment_intent_data.transfer_data.destination).toBe('acct_seller')
    expect(captured.metadata.listingId).toBe('lst_1')
  })

  test('throws when Stripe returns session without url', async () => {
    checkoutCreateImpl = async () => ({ url: null })
    await expect(svc.createCheckoutSession(CHECKOUT_BASE)).rejects.toThrow(
      'Checkout session has no URL',
    )
  })
})

// ──────────────────────────────────────────────────────────────────────
// createSubscriptionCheckout
// ──────────────────────────────────────────────────────────────────────

const SUB_BASE = {
  listingId: 'lst_1',
  buyerEmail: 'b@u.y',
  stripePriceId: 'price_x',
  creatorStripeAccountId: 'acct_seller',
  successUrl: 'https://ok',
  cancelUrl: 'https://no',
}

describe('createSubscriptionCheckout', () => {
  test('shortcut to successUrl when Stripe not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY
    expect(await svc.createSubscriptionCheckout(SUB_BASE)).toBe('https://ok')
  })

  test('passes mode=subscription and 20% fee percent', async () => {
    let captured: any
    checkoutCreateImpl = async (p: any) => {
      captured = p
      return { url: 'https://stripe/sub-1' }
    }
    const url = await svc.createSubscriptionCheckout(SUB_BASE)
    expect(url).toBe('https://stripe/sub-1')
    expect(captured.mode).toBe('subscription')
    expect(captured.subscription_data.application_fee_percent).toBe(20)
  })

  test('throws when missing url', async () => {
    checkoutCreateImpl = async () => ({})
    await expect(svc.createSubscriptionCheckout(SUB_BASE)).rejects.toThrow(
      'Checkout session has no URL',
    )
  })
})

// ──────────────────────────────────────────────────────────────────────
// triggerPayout
// ──────────────────────────────────────────────────────────────────────

describe('triggerPayout', () => {
  test('throws when profile has no stripe account', async () => {
    profiles.set('cp_1', { id: 'cp_1' })
    await expect(svc.triggerPayout('cp_1')).rejects.toThrow(
      'Creator has no Stripe Connect account',
    )
  })

  test('returns po_mock_* string in mock mode', async () => {
    delete process.env.STRIPE_SECRET_KEY
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_mock_1' })
    const id = await svc.triggerPayout('cp_1')
    expect(id).toMatch(/^po_mock_/)
  })

  test('live: throws "No amount available" when zero balance and no amount arg', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_live' })
    balanceRetrieveImpl = async () => ({ available: [{ amount: 0, currency: 'usd' }] })
    await expect(svc.triggerPayout('cp_1')).rejects.toThrow('No amount available to payout')
  })

  test('live: rejects when requested amount > available balance', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_live' })
    balanceRetrieveImpl = async () => ({ available: [{ amount: 100, currency: 'usd' }] })
    await expect(svc.triggerPayout('cp_1', 500)).rejects.toThrow(
      'Requested payout exceeds available balance',
    )
  })

  test('live: creates payout with full balance when amount omitted', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_live' })
    balanceRetrieveImpl = async () => ({ available: [{ amount: 2500, currency: 'usd' }] })
    let captured: any
    payoutsCreateImpl = async (p: any, opts: any) => {
      captured = { p, opts }
      return { id: 'po_real_x' }
    }
    const id = await svc.triggerPayout('cp_1')
    expect(id).toBe('po_real_x')
    expect(captured.p.amount).toBe(2500)
    expect(captured.p.currency).toBe('usd')
    expect(captured.opts.stripeAccount).toBe('acct_live')
  })

  test('live: handles missing usd entry (defaults available to 0)', async () => {
    profiles.set('cp_1', { id: 'cp_1', stripeCustomAccountId: 'acct_live' })
    balanceRetrieveImpl = async () => ({ available: [{ amount: 999, currency: 'eur' }] })
    await expect(svc.triggerPayout('cp_1')).rejects.toThrow('No amount available to payout')
  })
})

// ──────────────────────────────────────────────────────────────────────
// getAccountBalance
// ──────────────────────────────────────────────────────────────────────

describe('getAccountBalance', () => {
  test('returns 0 when Stripe is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY
    expect(await svc.getAccountBalance('acct_anything')).toBe(0)
  })

  test('returns USD amount when present', async () => {
    balanceRetrieveImpl = async () => ({
      available: [{ amount: 1234, currency: 'usd' }, { amount: 999, currency: 'eur' }],
    })
    expect(await svc.getAccountBalance('acct_a')).toBe(1234)
  })

  test('falls back to first entry when no USD row', async () => {
    balanceRetrieveImpl = async () => ({
      available: [{ amount: 777, currency: 'eur' }],
    })
    expect(await svc.getAccountBalance('acct_a')).toBe(777)
  })

  test('returns 0 when available list is empty', async () => {
    balanceRetrieveImpl = async () => ({ available: [] })
    expect(await svc.getAccountBalance('acct_a')).toBe(0)
  })
})

describe('PLATFORM_FEE_PERCENT', () => {
  test('exported constant is 20', () => {
    expect(svc.PLATFORM_FEE_PERCENT).toBe(20)
  })
})
