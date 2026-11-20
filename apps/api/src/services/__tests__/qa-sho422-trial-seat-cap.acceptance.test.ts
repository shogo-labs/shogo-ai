// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-422: a free trial never holds more than TRIAL_MAX_SEATS.
 *
 * The fraud: two Business trials of 123 and 166 seats on Hong Kong cards with
 * throwaway Gmail accounts, 1-2 real members each. Both passed CVC and 3D Secure
 * (SHO-409), so the card checks cannot catch them; at trial end Stripe would try
 * to charge ~$2k-$2.6k to a card we cannot collect on.
 *
 * These cover the Stripe-side enforcement (`enforceTrialSeatCap`), which the
 * webhook, `checkout.session.completed` and `verify-checkout` all share:
 *   AC4a — a trialing subscription *created* over the cap is blocked like any
 *           other refused trial: cancelled, recorded, no invoice, no wallet.
 *   AC4b — a trialing subscription *updated* over the cap is set back to the cap
 *           with `proration_behavior: 'none'`.
 * Stripe is mocked throughout: no network, no real charge.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ============================================================================
// In-memory prisma mock (only what trial.service touches on these paths)
// ============================================================================

type Redemption = {
  userId: string
  workspaceId: string
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
  cardFingerprint: string | null
  planId?: string
  status: string
}

const redemptions: Redemption[] = []
const members: Array<{ workspaceId: string; userId: string; role: string; projectId: string | null }> = []
const subscriptions: Array<{ workspaceId: string; status: string; id: string }> = []

const prismaApi: any = {
  trialRedemption: {
    findUnique: async ({ where, select }: any) => {
      const row = redemptions.find((r) => r.workspaceId === where.workspaceId) ?? null
      if (!row) return null
      if (!select) return row
      const out: any = {}
      for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k]
      return out
    },
    findFirst: async ({ where }: any) => {
      // Honour `status`, including `{ not: ... }`: `trialEligibility` excludes a
      // `blocked_seat_limit` row, and a mock that ignores the filter would report
      // "already_used" no matter what the service asked for.
      const statusOk = (r: Redemption) => {
        const filter = where?.status
        if (filter === undefined) return true
        if (typeof filter === 'string') return r.status === filter
        if (filter?.not !== undefined) return r.status !== filter.not
        if (Array.isArray(filter?.in)) return filter.in.includes(r.status)
        return true
      }
      for (const clause of where?.OR ?? []) {
        const hit = redemptions.find((r) => {
          if (!statusOk(r)) return false
          if (clause.workspaceId !== undefined && r.workspaceId !== clause.workspaceId) return false
          if (clause.userId !== undefined && r.userId !== clause.userId) return false
          if (clause.cardFingerprint !== undefined && r.cardFingerprint !== clause.cardFingerprint) return false
          return true
        })
        if (hit) return hit
      }
      return null
    },
    upsert: async ({ where, create, update }: any) => {
      const existing = redemptions.find((r) => r.workspaceId === where.workspaceId)
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      const fresh: Redemption = { ...create }
      redemptions.push(fresh)
      return fresh
    },
    findMany: async () => [],
  },
  member: {
    findFirst: async ({ where }: any) =>
      members.find(
        (m) => m.workspaceId === where.workspaceId
          && m.role === where.role
          && (where.projectId === null ? m.projectId === null : true),
      ) ?? null,
    findMany: async ({ where }: any) =>
      members.filter(
        (m) => m.workspaceId === where.workspaceId
          && (where.projectId === null ? m.projectId === null : true)
          && (where.userId?.not === undefined || m.userId !== where.userId.not),
      ),
  },
  subscription: {
    findFirst: async ({ where }: any) =>
      subscriptions.find((s) => s.workspaceId === where.workspaceId) ?? null,
  },
  signupRiskAssessment: {
    // SHO-459: banned-linked count resolves linked ids first.
    findMany: async () => [],
    findUnique: async () => null,
    findFirst: async () => null,
  },
}

mock.module('../../lib/prisma', () => ({
  prisma: prismaApi,
  SubscriptionStatus: { active: 'active', trialing: 'trialing', past_due: 'past_due', canceled: 'canceled' },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

const trial = await import('../trial.service')
const { TRIAL_MAX_SEATS } = await import('../../config/usage-plans')

// ============================================================================
// Stripe double — records every call so the assertions can read them
// ============================================================================

const stripeCalls: Array<{ method: string; args: any[] }> = []

class FakeStripe {
  subscriptions = {
    cancel: async (id: string) => {
      stripeCalls.push({ method: 'subscriptions.cancel', args: [id] })
      return { id, status: 'canceled' }
    },
    update: async (id: string, params: any) => {
      stripeCalls.push({ method: 'subscriptions.update', args: [id, params] })
      return { id, status: 'active', latest_invoice: { id: 'in_1', status: 'paid' } }
    },
  }
  subscriptionItems = {
    update: async (id: string, params: any) => {
      stripeCalls.push({ method: 'subscriptionItems.update', args: [id, params] })
      return { id, quantity: params.quantity }
    },
  }
  invoices = {
    create: async (params: any) => {
      stripeCalls.push({ method: 'invoices.create', args: [params] })
      return { id: 'in_should_not_exist' }
    },
  }
}

const stripe = new FakeStripe() as any

function baseParams(over: Record<string, any> = {}) {
  return {
    stripe,
    workspaceId: 'w1',
    planId: 'business',
    subscriptionId: 'sub_fraud',
    stripeCustomerId: 'cus_fraud',
    seatItemId: 'si_seat',
    ...over,
  }
}

beforeEach(() => {
  redemptions.length = 0
  members.length = 0
  subscriptions.length = 0
  stripeCalls.length = 0
  members.push({ workspaceId: 'w1', userId: 'u_owner', role: 'owner', projectId: null })
})

afterEach(() => {
  stripeCalls.length = 0
})

// ============================================================================
// AC4a — created over the cap is blocked, exactly like a refused trial
// ============================================================================

describe('AC4a: a trial created over the cap is cancelled and recorded', () => {
  it('blocks a 123-seat trial: cancel, record blocked_seat_limit, no invoice', async () => {
    const outcome = await trial.enforceTrialSeatCap({
      ...baseParams(),
      event: 'created',
      seats: 123,
    })
    expect(outcome).toEqual({ action: 'blocked' })
    expect(stripeCalls.map((c) => c.method)).toContain('subscriptions.cancel')
    // No invoice, no proration: the card is never charged.
    expect(stripeCalls.map((c) => c.method)).not.toContain('invoices.create')
    expect(stripeCalls.find((c) => c.method === 'subscriptions.cancel')!.args[0]).toBe('sub_fraud')
    // The row is what tells the owner *why*, via the trial-unavailable email.
    expect(redemptions.find((r) => r.workspaceId === 'w1')!.status).toBe('blocked_seat_limit')
    expect(await trial.getTrialBlockStatus('w1')).toBe('blocked_seat_limit')
  })

  it('a re-delivered event does not cancel or email twice', async () => {
    await trial.enforceTrialSeatCap({ ...baseParams(), event: 'created', seats: 123 })
    stripeCalls.length = 0
    const again = await trial.enforceTrialSeatCap({ ...baseParams(), event: 'created', seats: 123 })
    expect(again).toEqual({ action: 'already_blocked' })
    expect(stripeCalls).toEqual([])
  })

  it('a trial at the cap is left alone', async () => {
    const outcome = await trial.enforceTrialSeatCap({
      ...baseParams(),
      event: 'created',
      seats: TRIAL_MAX_SEATS,
    })
    expect(outcome).toEqual({ action: 'none' })
    expect(stripeCalls).toEqual([])
    expect(redemptions).toEqual([])
  })
})

// ============================================================================
// AC4b — a trial raised over the cap is put back
// ============================================================================

describe('AC4b: a trial raised over the cap is reset with no proration', () => {
  it('sets the seat item back to the cap', async () => {
    const outcome = await trial.enforceTrialSeatCap({
      ...baseParams(),
      event: 'updated',
      seats: 40,
    })
    expect(outcome).toEqual({ action: 'clamped', seats: TRIAL_MAX_SEATS })
    const call = stripeCalls.find((c) => c.method === 'subscriptionItems.update')
    expect(call).toBeDefined()
    expect(call!.args[0]).toBe('si_seat')
    expect(call!.args[1]).toEqual({
      quantity: TRIAL_MAX_SEATS,
      proration_behavior: 'none',
    })
    // A clamp never cancels the trial.
    expect(stripeCalls.map((c) => c.method)).not.toContain('subscriptions.cancel')
  })

  it('a trial already at the cap is not touched', async () => {
    const outcome = await trial.enforceTrialSeatCap({
      ...baseParams(),
      event: 'updated',
      seats: TRIAL_MAX_SEATS,
    })
    expect(outcome).toEqual({ action: 'none' })
    expect(stripeCalls).toEqual([])
  })
})

// ============================================================================
// Regression — a seat-limit block must not burn the customer's one trial
// ============================================================================

describe('a seat-limit block leaves the trial available at or under the cap', () => {
  it('a retry with TRIAL_MAX_SEATS seats is still trial-eligible', async () => {
    await trial.enforceTrialSeatCap({ ...baseParams(), event: 'created', seats: 123 })
    // The email tells the buyer they can "start the trial again with 5 seats or
    // fewer"; the checkout has to agree with that.
    const eligibility = await trial.trialEligibility({ userId: 'u_owner', workspaceId: 'w1', planId: 'business' })
    expect(eligibility).toEqual({ eligible: true })
  })

  it('every other block reason still burns the trial', async () => {
    // The seat cap is the only refusal that leaves the door open: the workspace
    // was turned away for its seat count, not for who it is. A duplicate card or
    // duplicate user must still read as `already_used`, or the exemption above
    // would hand a fraudster unlimited retries.
    for (const status of ['blocked_duplicate_card', 'blocked_duplicate_user', 'blocked_prepaid_card']) {
      redemptions.length = 0
      redemptions.push({
        userId: 'u_owner',
        workspaceId: 'w1',
        cardFingerprint: null,
        status,
      })
      const eligibility = await trial.trialEligibility({ userId: 'u_owner', workspaceId: 'w1', planId: 'business' })
      expect({ status, eligibility }).toEqual({ status, eligibility: { eligible: false, reason: 'already_used' } })
    }
  })
})
