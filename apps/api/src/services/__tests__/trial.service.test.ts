// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Free trial: checkout parameters, eligibility rules, and one-trial-per-card.
 * Prisma and Stripe are in-memory doubles.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { TRIAL_MAX_SEATS } from '../../config/usage-plans'

type Row = Record<string, any>
const redemptions: Row[] = []
const subscriptions: Row[] = []
const assessments = new Map<string, Row>()
const members: Row[] = []
const users: Row[] = []
const cancelled: string[] = []
let cardOf: Record<string, string | null> = {}
let fundingOf: Record<string, string> = {}
let failNextUpsertWithUniqueViolation = false

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((clause) => matches(row, clause))
    if (k === 'NOT') return !matches(row, v as Row)
    const actual = row[k] ?? null
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return actual !== (v as Row).not
      if ('in' in v) return ((v as Row).in as unknown[]).includes(actual)
      if ('gte' in v) return actual != null && new Date(actual) >= new Date((v as Row).gte)
      if ('lte' in v) return actual != null && new Date(actual) <= new Date((v as Row).lte)
    }
    return actual === v
  })
}

const assessmentRows = () => [...assessments.entries()].map(([userId, row]) => ({ userId, ...row }))

const prismaDouble = {
  trialRedemption: {
    findFirst: async ({ where }: { where: Row }) => redemptions.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: Row }) => redemptions.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: { where: Row }) => redemptions.filter((r) => matches(r, where)),
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      if (failNextUpsertWithUniqueViolation) {
        failNextUpsertWithUniqueViolation = false
        throw Object.assign(new Error('Unique constraint failed on cardFingerprint'), { code: 'P2002' })
      }
      const existing = redemptions.find((r) => matches(r, where))
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      const row = { ...create }
      redemptions.push(row)
      return row
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = redemptions.filter((r) => matches(r, where))
      rows.forEach((r) => Object.assign(r, data))
      return { count: rows.length }
    },
  },
  subscription: {
    findFirst: async ({ where }: { where: Row }) => subscriptions.find((s) => matches(s, where)) ?? null,
  },
  signupRiskAssessment: {
    // SHO-459: banned-linked count resolves linked ids first.
    findMany: async () => [],
    findUnique: async ({ where }: { where: Row }) => assessments.get(where.userId) ?? null,
    findFirst: async ({ where }: { where: Row }) => assessmentRows().find((r) => matches(r, where)) ?? null,
    count: async ({ where }: { where: Row }) => assessmentRows().filter((r) => matches(r, where)).length,
  },
  member: {
    findFirst: async ({ where }: { where: Row }) => members.find((m) => matches(m, where)) ?? null,
    findMany: async ({ where }: { where: Row }) => members.filter((m) => matches(m, where)),
  },
  user: {
    findUnique: async ({ where }: { where: Row }) => users.find((u) => matches(u, where)) ?? null,
    count: async ({ where }: { where: Row }) => users.filter((u) => matches(u, where)).length,
  },
}

mock.module('../../lib/prisma', () => ({ prisma: prismaDouble }))

const stripe: any = {
  subscriptions: {
    retrieve: async (id: string) => ({
      id,
      default_payment_method: cardOf[id]
        ? { id: `pm_${id}`, type: 'card', card: { fingerprint: cardOf[id], funding: fundingOf[id] ?? 'credit' } }
        : null,
    }),
    cancel: async (id: string) => {
      cancelled.push(id)
      return { id, status: 'canceled' }
    },
  },
}

const trial = await import('../trial.service')

beforeEach(() => {
  redemptions.length = 0
  subscriptions.length = 0
  assessments.clear()
  members.length = 0
  users.length = 0
  cancelled.length = 0
  cardOf = {}
  fundingOf = {}
  failNextUpsertWithUniqueViolation = false
  members.push({ userId: 'u-1', workspaceId: 'ws-1', role: 'owner', projectId: null, createdAt: new Date(0) })
})

describe('trialCheckoutParams', () => {
  test('zero days produces no parameters (normal paid checkout)', () => {
    expect(trial.trialCheckoutParams(0, { workspaceId: 'ws-1' })).toEqual({})
  })

  test('7 days requires a card, cancels if the trial ends without one, and tags the subscription', () => {
    const p = trial.trialCheckoutParams(7, { workspaceId: 'ws-1', planId: 'business' })
    expect(p.payment_method_collection).toBe('always')
    // Cards only: the one-trial-per-card rule needs a card fingerprint.
    expect(p.payment_method_types).toEqual(['card'])
    expect(p.subscription_data).toMatchObject({
      trial_period_days: 7,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { workspaceId: 'ws-1', planId: 'business', trial: 'true' },
    })
  })

  test('7 days requests 3D Secure on the card (SHO-409)', () => {
    const p = trial.trialCheckoutParams(7, { workspaceId: 'ws-1' })
    expect(p.payment_method_options).toEqual({ card: { request_three_d_secure: 'any' } })
  })
})

describe('buildCheckoutTrialFields', () => {
  const metadata = { workspaceId: 'ws-1', planId: 'business', billingInterval: 'monthly', seats: '1' }
  const affiliate = {
    subscription_data: { metadata: { affiliateId: 'aff-1' } },
    metadata: { affiliateId: 'aff-1' },
  }

  test('eligible trial: merges affiliate and trial subscription data, card-only', async () => {
    const f = await trial.buildCheckoutTrialFields({
      wantsTrial: true, userId: 'u-1', workspaceId: 'ws-1', planId: 'business', metadata, affiliate,
    })
    expect(f.metadata).toMatchObject({ ...metadata, affiliateId: 'aff-1', trial: 'true' })
    expect(f.subscription_data).toMatchObject({
      trial_period_days: 7,
      metadata: { ...metadata, affiliateId: 'aff-1', trial: 'true' },
    })
    expect(f.payment_method_types).toEqual(['card'])
  })

  test('ineligible or not requested: a normal checkout that keeps the affiliate tag', async () => {
    redemptions.push({ userId: 'u-1', workspaceId: 'ws-old', status: 'converted' })
    for (const wantsTrial of [true, false]) {
      const f = await trial.buildCheckoutTrialFields({
        wantsTrial, userId: 'u-1', workspaceId: 'ws-1', planId: 'business', metadata, affiliate,
      })
      expect(f.metadata).toEqual({ ...metadata, affiliateId: 'aff-1' })
      expect(f.subscription_data).toEqual({ metadata: { affiliateId: 'aff-1' } })
      expect(f.payment_method_collection).toBeUndefined()
      expect(f.payment_method_types).toBeUndefined()
    }
  })

  // The second check behind the routes' own gate (SHO-422 AC1): a caller that
  // forgets to gate still cannot open an over-cap trial.
  test('an eligible trial over the seat cap throws instead of opening the session', async () => {
    const err = await trial.buildCheckoutTrialFields({
      wantsTrial: true, userId: 'u-1', workspaceId: 'ws-1', planId: 'business',
      metadata: { ...metadata, seats: String(TRIAL_MAX_SEATS + 1) }, affiliate,
    }).then(() => null, (e: any) => e)
    expect(err).toBeInstanceOf(trial.TrialSeatLimitError)
    expect(err.code).toBe('trial_seat_limit')
    expect(err.seats).toBe(TRIAL_MAX_SEATS + 1)
    expect(err.message).toContain(`up to ${TRIAL_MAX_SEATS} seats`)
  })

  test('an eligible trial exactly at the seat cap is allowed', async () => {
    const f = await trial.buildCheckoutTrialFields({
      wantsTrial: true, userId: 'u-1', workspaceId: 'ws-1', planId: 'business',
      metadata: { ...metadata, seats: String(TRIAL_MAX_SEATS) }, affiliate,
    })
    expect(f.subscription_data).toMatchObject({ trial_period_days: 7 })
  })

  test('a paid checkout keeps any seat count', async () => {
    const f = await trial.buildCheckoutTrialFields({
      wantsTrial: false, userId: 'u-1', workspaceId: 'ws-1', planId: 'business',
      metadata: { ...metadata, seats: '50' }, affiliate,
    })
    expect(f.subscription_data).toEqual({ metadata: { affiliateId: 'aff-1' } })
  })
})

describe('trialEligibility', () => {
  test('a fresh user upgrading a workspace is eligible', async () => {
    expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-1', planId: 'business' })).toEqual({ eligible: true })
  })

  test('free and enterprise plans are not trial-eligible', async () => {
    expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-1', planId: 'free' })).toEqual({
      eligible: false,
      reason: 'plan_not_eligible',
    })
    expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-1', planId: 'enterprise' })).toEqual({
      eligible: false,
      reason: 'plan_not_eligible',
    })
  })

  test('retired Pro is not trial-eligible (SHO-397)', async () => {
    expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-1', planId: 'pro' })).toEqual({
      eligible: false,
      reason: 'plan_not_eligible',
    })
  })

  test('a user who already redeemed a trial on any workspace is not eligible again', async () => {
    redemptions.push({ userId: 'u-1', workspaceId: 'ws-old', status: 'converted' })
    expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-new', planId: 'basic' })).toEqual({
      eligible: false,
      reason: 'already_used',
    })
  })

  test('a workspace that ever had a subscription is not eligible', async () => {
    subscriptions.push({ workspaceId: 'ws-1', status: 'canceled' })
    expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-1', planId: 'business' })).toEqual({
      eligible: false,
      reason: 'existing_subscription',
    })
  })

  // A seat-limit block is not a trial that was used. The owner is told to
  // "start the trial again with 5 seats or fewer", so the row must not lock
  // them out of the retry it asks for (SHO-422, QA round 1).
  test('a blocked_seat_limit row does not burn the trial', async () => {
    redemptions.push({ userId: 'u-1', workspaceId: 'ws-1', status: 'blocked_seat_limit' })
    expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-1', planId: 'business' })).toEqual({
      eligible: true,
    })
  })

  test('the other block reasons still burn the trial', async () => {
    for (const status of ['blocked_duplicate_card', 'blocked_duplicate_user', 'blocked_prepaid_card']) {
      redemptions.length = 0
      redemptions.push({ userId: 'u-1', workspaceId: 'ws-1', status })
      expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-1', planId: 'business' })).toEqual({
        eligible: false,
        reason: 'already_used',
      })
    }
  })

  test('a high-risk signup goes to review and gets no trial', async () => {
    assessments.set('u-1', { band: 'high' })
    expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-1', planId: 'business' })).toEqual({
      eligible: false,
      reason: 'risk_review',
    })
  })

  test('plan-agnostic check (no planId) is used to show the trial CTA at all', async () => {
    expect((await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-1' })).eligible).toBe(true)
  })
})

describe('recordTrialStart (one trial per card)', () => {
  test('first trial on a card is recorded with its fingerprint', async () => {
    cardOf['sub_1'] = 'fp_A'
    const outcome = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'business',
      subscriptionId: 'sub_1', stripeCustomerId: 'cus_1',
    })
    expect(outcome).toBe('recorded')
    expect(cancelled).toHaveLength(0)
    expect(redemptions[0]).toMatchObject({ workspaceId: 'ws-1', cardFingerprint: 'fp_A', status: 'trialing' })
  })

  test('a prepaid card cannot start a trial: cancelled and blocked (SHO-409)', async () => {
    cardOf['sub_pre'] = 'fp_pre'
    fundingOf['sub_pre'] = 'prepaid'
    const outcome = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'business',
      subscriptionId: 'sub_pre', stripeCustomerId: 'cus_pre',
    })
    expect(outcome).toBe('blocked')
    expect(cancelled).toEqual(['sub_pre'])
    expect(redemptions.find((r) => r.workspaceId === 'ws-1')!.status).toBe('blocked_prepaid_card')
  })

  test('a debit card is recorded as today (only prepaid is refused)', async () => {
    cardOf['sub_deb'] = 'fp_deb'
    fundingOf['sub_deb'] = 'debit'
    const outcome = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'business',
      subscriptionId: 'sub_deb', stripeCustomerId: 'cus_deb',
    })
    expect(outcome).toBe('recorded')
    expect(cancelled).toHaveLength(0)
  })

  test('a card already used for a trial on another workspace is cancelled and blocked', async () => {
    redemptions.push({ userId: 'u-0', workspaceId: 'ws-other', cardFingerprint: 'fp_A', status: 'converted' })
    cardOf['sub_2'] = 'fp_A'
    const outcome = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'business',
      subscriptionId: 'sub_2', stripeCustomerId: 'cus_2',
    })
    expect(outcome).toBe('blocked')
    expect(cancelled).toEqual(['sub_2'])
    expect(redemptions.find((r) => r.workspaceId === 'ws-1')!.status).toBe('blocked_duplicate_card')
  })

  test('a re-delivered webhook for a blocked trial stays blocked (does not un-block)', async () => {
    redemptions.push({ userId: 'u-0', workspaceId: 'ws-other', cardFingerprint: 'fp_A', status: 'converted' })
    cardOf['sub_2'] = 'fp_A'
    await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'business',
      subscriptionId: 'sub_2', stripeCustomerId: 'cus_2',
    })
    const again = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'business',
      subscriptionId: 'sub_2', stripeCustomerId: 'cus_2',
    })
    expect(again).toBe('already_blocked')
    expect(cancelled).toEqual(['sub_2'])
  })

  test('the same owner starting a second trial on another workspace is blocked', async () => {
    redemptions.push({ userId: 'u-1', workspaceId: 'ws-other', cardFingerprint: 'fp_A', status: 'trialing' })
    cardOf['sub_4'] = 'fp_B'
    const outcome = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'business',
      subscriptionId: 'sub_4', stripeCustomerId: 'cus_4',
    })
    expect(outcome).toBe('blocked')
    expect(cancelled).toEqual(['sub_4'])
    expect(redemptions.find((r) => r.workspaceId === 'ws-1')!.status).toBe('blocked_duplicate_user')
  })

  test('losing the race for a card fingerprint is treated as a duplicate card', async () => {
    cardOf['sub_5'] = 'fp_C'
    failNextUpsertWithUniqueViolation = true
    const outcome = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'business',
      subscriptionId: 'sub_5', stripeCustomerId: 'cus_5',
    })
    expect(outcome).toBe('blocked')
    expect(cancelled).toEqual(['sub_5'])
    expect(redemptions.find((r) => r.workspaceId === 'ws-1')!.status).toBe('blocked_duplicate_card')
  })

  test('a re-delivered webhook for a recorded trial is a no-op', async () => {
    cardOf['sub_1'] = 'fp_A'
    await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'business',
      subscriptionId: 'sub_1', stripeCustomerId: 'cus_1',
    })
    const again = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'business',
      subscriptionId: 'sub_1', stripeCustomerId: 'cus_1',
    })
    expect(again).toBe('already_recorded')
  })

  test('the same card on the same workspace is not treated as a duplicate', async () => {
    redemptions.push({ userId: 'u-1', workspaceId: 'ws-1', cardFingerprint: null, status: 'converted' })
    cardOf['sub_3'] = 'fp_B'
    const outcome = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'business',
      subscriptionId: 'sub_3', stripeCustomerId: 'cus_3',
    })
    expect(outcome).toBe('recorded')
    expect(cancelled).toHaveLength(0)
  })
})

describe('trial status transitions', () => {
  test('converted only moves an active trial (a blocked row keeps its status)', async () => {
    redemptions.push({ workspaceId: 'ws-1', status: 'trialing' })
    redemptions.push({ workspaceId: 'ws-2', status: 'blocked_duplicate_card' })
    await trial.markTrialConverted('ws-1')
    await trial.markTrialConverted('ws-2')
    expect(redemptions[0].status).toBe('converted')
    expect(redemptions[1].status).toBe('blocked_duplicate_card')
  })

  test('a subscription deleted while trialing ends the trial; a converted one is untouched', async () => {
    redemptions.push({ workspaceId: 'ws-1', stripeSubscriptionId: 'sub_1', status: 'trialing' })
    redemptions.push({ workspaceId: 'ws-2', stripeSubscriptionId: 'sub_2', status: 'converted' })
    await trial.markTrialEndedForSubscription('sub_1')
    await trial.markTrialEndedForSubscription('sub_2')
    expect(redemptions[0].status).toBe('ended')
    expect(redemptions[1].status).toBe('converted')
  })
})

describe('endTrialNow', () => {
  function stripeDouble(update: (id: string, params: any) => any) {
    const calls: Array<{ id: string; params: any }> = []
    return {
      calls,
      stripe: {
        subscriptions: {
          update: async (id: string, params: any) => {
            calls.push({ id, params })
            return update(id, params)
          },
        },
      } as any,
    }
  }

  test('ends the trial now and reports the invoice status', async () => {
    const { calls, stripe: s } = stripeDouble(() => ({
      id: 'sub_1',
      status: 'active',
      latest_invoice: { id: 'in_1', status: 'paid' },
    }))
    const result = await trial.endTrialNow({ stripe: s, stripeSubscriptionId: 'sub_1' })
    expect(result).toEqual({ status: 'active', latestInvoiceStatus: 'paid' })
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('sub_1')
    expect(calls[0].params.trial_end).toBe('now')
    expect(calls[0].params.proration_behavior).toBe('none')
    expect(calls[0].params.expand).toEqual(['latest_invoice'])
  })

  test('reports an open invoice instead of claiming the charge went through', async () => {
    const { stripe: s } = stripeDouble(() => ({
      id: 'sub_1',
      status: 'past_due',
      latest_invoice: { id: 'in_1', status: 'open' },
    }))
    const result = await trial.endTrialNow({ stripe: s, stripeSubscriptionId: 'sub_1' })
    expect(result).toEqual({ status: 'past_due', latestInvoiceStatus: 'open' })
  })

  test('reports a null invoice status when Stripe returns an unexpanded id', async () => {
    const { stripe: s } = stripeDouble(() => ({
      id: 'sub_1',
      status: 'active',
      latest_invoice: 'in_1',
    }))
    const result = await trial.endTrialNow({ stripe: s, stripeSubscriptionId: 'sub_1' })
    expect(result.latestInvoiceStatus).toBeNull()
  })
})

/**
 * The two webhook shapes the seat cap has to survive (SHO-422 AC4). Both go
 * through `enforceTrialSeatCap`, so these are the tests for the webhook branches
 * without standing up the webhook itself.
 */
describe('enforceTrialSeatCap', () => {
  const seatItemUpdates: Array<{ id: string; params: any }> = []

  beforeEach(() => {
    seatItemUpdates.length = 0
  })

  function webhookStripe(opts: { cancelThrows?: boolean } = {}) {
    return {
      subscriptions: {
        cancel: async (id: string) => {
          if (opts.cancelThrows) throw new Error('No such subscription')
          cancelled.push(id)
          return { id, status: 'canceled' }
        },
      },
      subscriptionItems: {
        update: async (id: string, params: any) => {
          seatItemUpdates.push({ id, params })
          return { id, quantity: params.quantity }
        },
      },
    } as any
  }

  const created = {
    event: 'created' as const,
    workspaceId: 'ws-1',
    planId: 'business',
    subscriptionId: 'sub_big',
    stripeCustomerId: 'cus_big',
    seats: 123,
    seatItemId: null,
  }

  test('a subscription created over the cap is blocked, not clamped', async () => {
    const outcome = await trial.enforceTrialSeatCap({ ...created, stripe: webhookStripe() })
    expect(outcome).toEqual({ action: 'blocked' })
    // Cancelled with no invoice and no proration — `cancel`, never an update.
    expect(cancelled).toEqual(['sub_big'])
    expect(seatItemUpdates).toHaveLength(0)
    expect(redemptions[0].status).toBe('blocked_seat_limit')
    expect(redemptions[0].stripeSubscriptionId).toBe('sub_big')
    expect(redemptions[0].userId).toBe('u-1')
    expect(await trial.getTrialBlockStatus('ws-1')).toBe('blocked_seat_limit')
  })

  test('a re-delivered created event does not block or cancel twice', async () => {
    redemptions.push({ workspaceId: 'ws-1', stripeSubscriptionId: 'sub_big', status: 'blocked_seat_limit' })
    const outcome = await trial.enforceTrialSeatCap({ ...created, stripe: webhookStripe() })
    expect(outcome).toEqual({ action: 'already_blocked' })
    expect(cancelled).toHaveLength(0)
  })

  test('an already-cancelled subscription still records the block', async () => {
    const outcome = await trial.enforceTrialSeatCap({
      ...created,
      stripe: webhookStripe({ cancelThrows: true }),
    })
    expect(outcome).toEqual({ action: 'blocked' })
    expect(redemptions[0].status).toBe('blocked_seat_limit')
  })

  test('a subscription updated over the cap has its seat item reset to the cap', async () => {
    const outcome = await trial.enforceTrialSeatCap({
      ...created,
      event: 'updated',
      seats: 40,
      seatItemId: 'si_seat',
      stripe: webhookStripe(),
    })
    expect(outcome).toEqual({ action: 'clamped', seats: TRIAL_MAX_SEATS })
    expect(seatItemUpdates).toHaveLength(1)
    expect(seatItemUpdates[0].id).toBe('si_seat')
    expect(seatItemUpdates[0].params).toEqual({
      quantity: TRIAL_MAX_SEATS,
      proration_behavior: 'none',
    })
    // An update is not a block: the trial keeps running at the cap.
    expect(cancelled).toHaveLength(0)
    expect(redemptions).toHaveLength(0)
  })

  test('a subscription at the cap is left alone', async () => {
    const outcome = await trial.enforceTrialSeatCap({
      ...created,
      seats: TRIAL_MAX_SEATS,
      stripe: webhookStripe(),
    })
    expect(outcome).toEqual({ action: 'none' })
    expect(cancelled).toHaveLength(0)
    expect(seatItemUpdates).toHaveLength(0)
  })
})

// ===========================================================================
// SHO-440: trial farming on one network
// ===========================================================================

const FARM_IP = '118.99.73.148'

function request(over: Partial<{ ip: string; ipPrefix: string; deviceId: string | null }> = {}) {
  return {
    ip: FARM_IP,
    ipPrefix: FARM_IP,
    country: 'HK',
    deviceId: null,
    e2eAllowlisted: false,
    ...over,
  }
}

/** The four Nov 18 accounts: three Google sign-ups and one credential. */
function seedNov18Farm() {
  const accounts = [
    { id: 'u-google-1', email: 'pasipalapasi9@gmail.com', band: 'low', deviceId: null, provider: 'social' },
    { id: 'u-google-2', email: 'burhannudinaps@gmail.com', band: 'low', deviceId: null, provider: 'social' },
    { id: 'u-google-3', email: 'wicakwicak39@students.unnes.ac.id', band: 'low', deviceId: null, provider: 'social' },
    { id: 'u-cred', email: 'cioganteng@my.id', band: 'high', deviceId: 'dev-shared-0001', provider: 'credential' },
  ]
  for (const a of accounts) {
    users.push({ id: a.id, email: a.email, emailVerified: true, emailCanonical: a.email })
    assessments.set(a.id, {
      band: a.band,
      ipPrefix: FARM_IP,
      deviceId: a.deviceId,
      signals: { provider: a.provider },
      reviewDecision: null,
      // An hour ago: inside the 30-day window, outside the 10-minute burst, so
      // the IP cluster is the only signal and trial 1 stays eligible.
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    })
  }
  // One workspace per account, and the high-risk credential account is a
  // member of burhannudinaps's workspace — exactly the Nov 18 shape.
  for (const [i, a] of accounts.entries()) {
    members.push({ userId: a.id, workspaceId: `ws-${i + 1}`, role: 'owner', projectId: null, createdAt: new Date(0) })
  }
  members.push({ userId: 'u-cred', workspaceId: 'ws-2', role: 'member', projectId: null, createdAt: new Date(0) })
}

describe('trialEligibility: one trial per network (SHO-440)', () => {
  test('the Nov 18 farm: trial 1 is eligible, trials 2-4 are refused', async () => {
    seedNov18Farm()

    // Trial 1: the first Google account on the IP.
    expect(await trial.trialEligibility({
      userId: 'u-google-1', workspaceId: 'ws-1', planId: 'business', request: request(),
    })).toEqual({ eligible: true, checkoutRiskScore: 40 })
    redemptions.push({ userId: 'u-google-1', workspaceId: 'ws-1', status: 'trialing', createdAt: new Date() })

    // Trial 2: burhannudinaps's workspace holds the high-risk credential account.
    expect(await trial.trialEligibility({
      userId: 'u-google-2', workspaceId: 'ws-2', planId: 'business', request: request(),
    })).toEqual({ eligible: false, reason: 'risk_review', detail: 'member_high_risk' })

    // Trial 3: no high-risk member, but the network already has a trial.
    expect(await trial.trialEligibility({
      userId: 'u-google-3', workspaceId: 'ws-3', planId: 'business', request: request(),
    })).toEqual({
      eligible: false,
      reason: 'risk_review',
      detail: 'network_trial_used',
      checkoutRiskScore: 40,
    })

    // Trial 4: the credential account is high risk on its own signup score.
    expect(await trial.trialEligibility({
      userId: 'u-cred', workspaceId: 'ws-4', planId: 'business', request: request(),
    })).toEqual({ eligible: false, reason: 'risk_review' })
  })

  test('a clean Google sign-up on a new network still gets a trial', async () => {
    users.push({ id: 'u-clean', email: 'clean@gmail.com', emailVerified: true, emailCanonical: 'clean@gmail.com' })
    assessments.set('u-clean', {
      band: 'low', ipPrefix: '203.0.113.9', deviceId: 'dev-clean-0001',
      signals: { provider: 'social' }, reviewDecision: null, createdAt: new Date(),
    })
    members.push({ userId: 'u-clean', workspaceId: 'ws-clean', role: 'owner', projectId: null, createdAt: new Date(0) })

    const result = await trial.trialEligibility({
      userId: 'u-clean',
      workspaceId: 'ws-clean',
      planId: 'business',
      request: request({ ip: '203.0.113.9', ipPrefix: '203.0.113.9', deviceId: 'dev-clean-0001' }),
    })
    expect(result.eligible).toBe(true)
    expect(result.checkoutRiskScore).toBe(0)
  })

  test('a trial on the same device is refused even from a different IP', async () => {
    users.push({ id: 'u-a', email: 'a@example.com', emailVerified: true, emailCanonical: 'a@example.com' })
    users.push({ id: 'u-b', email: 'b@example.com', emailVerified: true, emailCanonical: 'b@example.com' })
    assessments.set('u-a', {
      band: 'low', ipPrefix: '198.51.100.1', deviceId: 'dev-shared-0002',
      signals: { provider: 'credential' }, reviewDecision: null, createdAt: new Date(),
    })
    assessments.set('u-b', {
      band: 'low', ipPrefix: '198.51.100.2', deviceId: 'dev-shared-0002',
      signals: { provider: 'credential' }, reviewDecision: null, createdAt: new Date(),
    })
    members.push({ userId: 'u-b', workspaceId: 'ws-b', role: 'owner', projectId: null, createdAt: new Date(0) })
    redemptions.push({ userId: 'u-a', workspaceId: 'ws-a', status: 'ended', createdAt: new Date() })

    // No checkout request: the buyer's own signup device is what matches.
    expect(await trial.trialEligibility({
      userId: 'u-b',
      workspaceId: 'ws-b',
      planId: 'business',
    })).toMatchObject({ eligible: false, reason: 'risk_review', detail: 'network_trial_used' })
  })

  test('a trial older than the window does not block the network', async () => {
    users.push({ id: 'u-old', email: 'old@example.com', emailVerified: true, emailCanonical: 'old@example.com' })
    users.push({ id: 'u-new', email: 'new@example.com', emailVerified: true, emailCanonical: 'new@example.com' })
    assessments.set('u-old', {
      band: 'low', ipPrefix: '198.51.100.7', deviceId: null,
      signals: { provider: 'credential' }, reviewDecision: null, createdAt: new Date(),
    })
    assessments.set('u-new', {
      band: 'low', ipPrefix: '198.51.100.7', deviceId: null,
      signals: { provider: 'credential' }, reviewDecision: null, createdAt: new Date(),
    })
    members.push({ userId: 'u-new', workspaceId: 'ws-new', role: 'owner', projectId: null, createdAt: new Date(0) })
    redemptions.push({
      userId: 'u-old',
      workspaceId: 'ws-old',
      status: 'ended',
      createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    })

    expect((await trial.trialEligibility({
      userId: 'u-new',
      workspaceId: 'ws-new',
      planId: 'business',
      request: request({ ip: '198.51.100.7', ipPrefix: '198.51.100.7' }),
    })).eligible).toBe(true)
  })

  test('a high-risk member cleared by an admin review does not block the trial', async () => {
    users.push({ id: 'u-owner', email: 'owner@example.com', emailVerified: true, emailCanonical: 'owner@example.com' })
    users.push({ id: 'u-reviewed', email: 'reviewed@example.com', emailVerified: true, emailCanonical: 'reviewed@example.com' })
    assessments.set('u-owner', {
      band: 'low', ipPrefix: '192.0.2.5', deviceId: null,
      signals: { provider: 'credential' }, reviewDecision: null, createdAt: new Date(),
    })
    assessments.set('u-reviewed', {
      band: 'high', ipPrefix: '192.0.2.6', deviceId: null,
      signals: { provider: 'credential' }, reviewDecision: 'approved', createdAt: new Date(),
    })
    members.push({ userId: 'u-owner', workspaceId: 'ws-owner', role: 'owner', projectId: null, createdAt: new Date(0) })
    members.push({ userId: 'u-reviewed', workspaceId: 'ws-owner', role: 'member', projectId: null, createdAt: new Date(0) })

    expect((await trial.trialEligibility({
      userId: 'u-owner',
      workspaceId: 'ws-owner',
      planId: 'business',
      request: request({ ip: '192.0.2.5', ipPrefix: '192.0.2.5' }),
    })).eligible).toBe(true)
  })

  test('the checkout re-score refuses a high-risk checkout even when the signup score was low', async () => {
    users.push({ id: 'u-sneaky', email: 'sneaky@example.com', emailVerified: true, emailCanonical: 'sneaky@example.com' })
    assessments.set('u-sneaky', {
      band: 'low', ipPrefix: '203.0.113.50', deviceId: null,
      signals: { provider: 'social' }, reviewDecision: null, createdAt: new Date(),
    })
    members.push({ userId: 'u-sneaky', workspaceId: 'ws-sneaky', role: 'owner', projectId: null, createdAt: new Date(0) })
    // Four other accounts already signed up from the checkout IP, just now:
    // ip_cluster_4plus (40) + signup_burst_10m (20) = 60, high.
    for (let i = 0; i < 4; i++) {
      assessments.set(`u-other-${i}`, {
        band: 'low', ipPrefix: '203.0.113.99', deviceId: null,
        signals: { provider: 'credential' }, reviewDecision: null, createdAt: new Date(),
      })
    }

    expect(await trial.trialEligibility({
      userId: 'u-sneaky',
      workspaceId: 'ws-sneaky',
      planId: 'business',
      request: request({ ip: '203.0.113.99', ipPrefix: '203.0.113.99' }),
    })).toMatchObject({ eligible: false, reason: 'risk_review', detail: 'checkout_high_risk' })
  })

  test('the checkout re-score never writes the signup assessment', async () => {
    users.push({ id: 'u-keep', email: 'keep@example.com', emailVerified: true, emailCanonical: 'keep@example.com' })
    assessments.set('u-keep', {
      band: 'low', ipPrefix: '203.0.113.60', deviceId: null,
      signals: { provider: 'social' }, reviewDecision: null, createdAt: new Date(),
    })
    members.push({ userId: 'u-keep', workspaceId: 'ws-keep', role: 'owner', projectId: null, createdAt: new Date(0) })
    const before = { ...assessments.get('u-keep')! }

    await trial.trialEligibility({
      userId: 'u-keep',
      workspaceId: 'ws-keep',
      planId: 'business',
      request: request({ ip: '203.0.113.60', ipPrefix: '203.0.113.60' }),
    })
    expect(assessments.get('u-keep')).toEqual(before)
  })
})

describe('recordTrialStart: network backstop (SHO-440)', () => {
  test('two workspaces whose owners share an IP: the second is blocked_duplicate_network', async () => {
    users.push({ id: 'u-1', email: 'one@example.com', emailVerified: true, emailCanonical: 'one@example.com' })
    users.push({ id: 'u-2', email: 'two@example.com', emailVerified: true, emailCanonical: 'two@example.com' })
    assessments.set('u-1', { band: 'low', ipPrefix: FARM_IP, deviceId: null, signals: {}, reviewDecision: null })
    assessments.set('u-2', { band: 'low', ipPrefix: FARM_IP, deviceId: null, signals: {}, reviewDecision: null })
    members.push({ userId: 'u-2', workspaceId: 'ws-2', role: 'owner', projectId: null, createdAt: new Date(0) })

    // The first checkout completed and recorded its trial.
    redemptions.push({ userId: 'u-1', workspaceId: 'ws-1', status: 'trialing', createdAt: new Date() })

    cardOf['sub_2'] = 'fp_network'
    const outcome = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-2', userId: 'u-2', planId: 'business',
      subscriptionId: 'sub_2', stripeCustomerId: 'cus_2',
    })
    expect(outcome).toBe('blocked')
    expect(cancelled).toEqual(['sub_2'])
    expect(redemptions.find((r) => r.workspaceId === 'ws-2')!.status).toBe('blocked_duplicate_network')
    expect(await trial.getTrialBlockStatus('ws-2')).toBe('blocked_duplicate_network')
  })

  test('a different network is recorded normally', async () => {
    users.push({ id: 'u-1', email: 'one@example.com', emailVerified: true, emailCanonical: 'one@example.com' })
    users.push({ id: 'u-2', email: 'two@example.com', emailVerified: true, emailCanonical: 'two@example.com' })
    assessments.set('u-1', { band: 'low', ipPrefix: FARM_IP, deviceId: null, signals: {}, reviewDecision: null })
    assessments.set('u-2', { band: 'low', ipPrefix: '203.0.113.200', deviceId: null, signals: {}, reviewDecision: null })
    members.push({ userId: 'u-2', workspaceId: 'ws-2', role: 'owner', projectId: null, createdAt: new Date(0) })
    redemptions.push({ userId: 'u-1', workspaceId: 'ws-1', status: 'trialing', createdAt: new Date() })

    cardOf['sub_2'] = 'fp_other'
    const outcome = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-2', userId: 'u-2', planId: 'business',
      subscriptionId: 'sub_2', stripeCustomerId: 'cus_2',
    })
    expect(outcome).toBe('recorded')
    expect(cancelled).toHaveLength(0)
  })
})
