// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Free trial: checkout parameters, eligibility rules, and one-trial-per-card.
 * Prisma and Stripe are in-memory doubles.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type Row = Record<string, any>
const redemptions: Row[] = []
const subscriptions: Row[] = []
const assessments = new Map<string, Row>()
const members: Row[] = []
const cancelled: string[] = []
let cardOf: Record<string, string | null> = {}
let failNextUpsertWithUniqueViolation = false

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((clause) => matches(row, clause))
    if (v && typeof v === 'object' && 'not' in v) return (row[k] ?? null) !== v.not
    return (row[k] ?? null) === v
  })
}

const prismaDouble = {
  trialRedemption: {
    findFirst: async ({ where }: { where: Row }) => redemptions.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: Row }) => redemptions.find((r) => matches(r, where)) ?? null,
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
    findUnique: async ({ where }: { where: Row }) => assessments.get(where.userId) ?? null,
  },
  member: {
    findFirst: async ({ where }: { where: Row }) => members.find((m) => matches(m, where)) ?? null,
  },
}

mock.module('../../lib/prisma', () => ({ prisma: prismaDouble }))

const stripe: any = {
  subscriptions: {
    retrieve: async (id: string) => ({
      id,
      default_payment_method: cardOf[id]
        ? { id: `pm_${id}`, type: 'card', card: { fingerprint: cardOf[id] } }
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
  cancelled.length = 0
  cardOf = {}
  failNextUpsertWithUniqueViolation = false
  members.push({ userId: 'u-1', workspaceId: 'ws-1', role: 'owner', projectId: null, createdAt: new Date(0) })
})

describe('trialCheckoutParams', () => {
  test('zero days produces no parameters (normal paid checkout)', () => {
    expect(trial.trialCheckoutParams(0, { workspaceId: 'ws-1' })).toEqual({})
  })

  test('7 days requires a card, cancels if the trial ends without one, and tags the subscription', () => {
    const p = trial.trialCheckoutParams(7, { workspaceId: 'ws-1', planId: 'pro' })
    expect(p.payment_method_collection).toBe('always')
    // Cards only: the one-trial-per-card rule needs a card fingerprint.
    expect(p.payment_method_types).toEqual(['card'])
    expect(p.subscription_data).toMatchObject({
      trial_period_days: 7,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { workspaceId: 'ws-1', planId: 'pro', trial: 'true' },
    })
  })
})

describe('buildCheckoutTrialFields', () => {
  const metadata = { workspaceId: 'ws-1', planId: 'pro', billingInterval: 'monthly', seats: '1' }
  const affiliate = {
    subscription_data: { metadata: { affiliateId: 'aff-1' } },
    metadata: { affiliateId: 'aff-1' },
  }

  test('eligible trial: merges affiliate and trial subscription data, card-only', async () => {
    const f = await trial.buildCheckoutTrialFields({
      wantsTrial: true, userId: 'u-1', workspaceId: 'ws-1', planId: 'pro', metadata, affiliate,
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
        wantsTrial, userId: 'u-1', workspaceId: 'ws-1', planId: 'pro', metadata, affiliate,
      })
      expect(f.metadata).toEqual({ ...metadata, affiliateId: 'aff-1' })
      expect(f.subscription_data).toEqual({ metadata: { affiliateId: 'aff-1' } })
      expect(f.payment_method_collection).toBeUndefined()
      expect(f.payment_method_types).toBeUndefined()
    }
  })
})

describe('trialEligibility', () => {
  test('a fresh user upgrading a workspace is eligible', async () => {
    expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-1', planId: 'pro' })).toEqual({ eligible: true })
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

  test('a user who already redeemed a trial on any workspace is not eligible again', async () => {
    redemptions.push({ userId: 'u-1', workspaceId: 'ws-old', status: 'converted' })
    expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-new', planId: 'basic' })).toEqual({
      eligible: false,
      reason: 'already_used',
    })
  })

  test('a workspace that ever had a subscription is not eligible', async () => {
    subscriptions.push({ workspaceId: 'ws-1', status: 'canceled' })
    expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-1', planId: 'pro' })).toEqual({
      eligible: false,
      reason: 'existing_subscription',
    })
  })

  test('a high-risk signup goes to review and gets no trial', async () => {
    assessments.set('u-1', { band: 'high' })
    expect(await trial.trialEligibility({ userId: 'u-1', workspaceId: 'ws-1', planId: 'pro' })).toEqual({
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
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'pro',
      subscriptionId: 'sub_1', stripeCustomerId: 'cus_1',
    })
    expect(outcome).toBe('recorded')
    expect(cancelled).toHaveLength(0)
    expect(redemptions[0]).toMatchObject({ workspaceId: 'ws-1', cardFingerprint: 'fp_A', status: 'trialing' })
  })

  test('a card already used for a trial on another workspace is cancelled and blocked', async () => {
    redemptions.push({ userId: 'u-0', workspaceId: 'ws-other', cardFingerprint: 'fp_A', status: 'converted' })
    cardOf['sub_2'] = 'fp_A'
    const outcome = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'pro',
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
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'pro',
      subscriptionId: 'sub_2', stripeCustomerId: 'cus_2',
    })
    const again = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'pro',
      subscriptionId: 'sub_2', stripeCustomerId: 'cus_2',
    })
    expect(again).toBe('already_blocked')
    expect(cancelled).toEqual(['sub_2'])
  })

  test('the same owner starting a second trial on another workspace is blocked', async () => {
    redemptions.push({ userId: 'u-1', workspaceId: 'ws-other', cardFingerprint: 'fp_A', status: 'trialing' })
    cardOf['sub_4'] = 'fp_B'
    const outcome = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'pro',
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
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'pro',
      subscriptionId: 'sub_5', stripeCustomerId: 'cus_5',
    })
    expect(outcome).toBe('blocked')
    expect(cancelled).toEqual(['sub_5'])
    expect(redemptions.find((r) => r.workspaceId === 'ws-1')!.status).toBe('blocked_duplicate_card')
  })

  test('a re-delivered webhook for a recorded trial is a no-op', async () => {
    cardOf['sub_1'] = 'fp_A'
    await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'pro',
      subscriptionId: 'sub_1', stripeCustomerId: 'cus_1',
    })
    const again = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'pro',
      subscriptionId: 'sub_1', stripeCustomerId: 'cus_1',
    })
    expect(again).toBe('already_recorded')
  })

  test('the same card on the same workspace is not treated as a duplicate', async () => {
    redemptions.push({ userId: 'u-1', workspaceId: 'ws-1', cardFingerprint: null, status: 'converted' })
    cardOf['sub_3'] = 'fp_B'
    const outcome = await trial.recordTrialStart({
      stripe, workspaceId: 'ws-1', userId: 'u-1', planId: 'pro',
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
