// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-409: a trial must never run up overage we cannot collect.
 *
 * The bug: `resolveEffectivePlan` treats `status: 'trialing'` as a paid tier, so
 * once a trial's rolling windows and $10 promo were spent a trial workspace with
 * `overageEnabled` fell through to overage. The card had never been charged (a
 * trial's first invoice is $0), so the first real charge was our $25 overage
 * block invoice — and for the 9 fraud trials of Nov 1-13 it failed every time
 * (~$370 unrecoverable).
 *
 * The fix has three parts, each covered here:
 *   1. overage is gated on `Subscription.firstPaidAt` (`overageTrusted`),
 *   2. `invoice.payment_succeeded` sets it for a real (amount_paid > 0) invoice,
 *   3. trial checkout asks for 3D Secure and refuses prepaid cards.
 *
 * AC1-AC6 from the card map onto the describes below.
 */
import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test'
import * as realStripePrices from '../../config/stripe-prices'

// ============================================================================
// In-memory prisma mock (billing.service + trial.service share it)
// ============================================================================

type Sub = {
  id: string
  workspaceId: string
  stripeSubscriptionId: string
  stripeCustomerId: string
  planId: string
  seats: number
  status: string
  billingInterval: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
  createdAt: Date
  firstPaidAt?: Date | null
}
type Wallet = {
  workspaceId: string
  monthlyIncludedUsd: number
  monthlyIncludedAllocationUsd: number
  dailyIncludedUsd: number
  dailyUsedThisMonthUsd: number
  overageAccumulatedUsd: number
  overageBilledUsd: number
  overageEnabled: boolean
  overageHardLimitUsd: number | null
  overagePaidBlocks: number
  overageOutstandingInvoiceId: string | null
  overageOutstandingUsd: number
  anniversaryDay: number
  lastDailyReset: Date
  lastMonthlyReset: Date
  fiveHourWindowStart: Date | null
  fiveHourUsedUsd: number
  weeklyWindowStart: Date | null
  weeklyUsedUsd: number
  promoCreditUsd: number
  promoCreditExpiresAt: Date | null
}
type Grant = {
  id: string
  workspaceId: string
  freeSeats: number
  monthlyIncludedUsd: number
  planId: string | null
  startsAt: Date
  expiresAt: Date | null
}
type Redemption = {
  userId: string
  workspaceId: string
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
  cardFingerprint: string | null
  planId?: string
  status: string
}

const subs = new Map<string, Sub[]>()
const wallets = new Map<string, Wallet>()
const grants = new Map<string, Grant[]>()
const redemptions: Redemption[] = []
const members: Array<{ workspaceId: string; userId: string; role: string; projectId: string | null }> = []
const workspaces = new Map<string, { id: string; name: string; slug: string; parentWorkspaceId?: string | null }>()
const usageEvents: any[] = []

function flattenSubs(): Sub[] {
  const out: Sub[] = []
  for (const arr of subs.values()) out.push(...arr)
  return out
}

/** The migration's backfill, mirrored: an active/past_due row has been charged. */
function effectiveFirstPaidAt(s: Sub): Date | null {
  if (s.firstPaidAt !== undefined) return s.firstPaidAt
  return s.status === 'active' || s.status === 'past_due' ? s.currentPeriodStart : null
}

function project<T extends Record<string, any>>(row: T, select: any): any {
  if (!select) return row
  const out: any = {}
  for (const k of Object.keys(select)) if (select[k]) out[k] = row[k]
  return out
}

const prismaApi: any = {
  subscription: {
    findFirst: async ({ where, select, orderBy }: any) => {
      let candidates = where?.workspaceId ? (subs.get(where.workspaceId) ?? []) : flattenSubs()
      if (where?.status?.in) candidates = candidates.filter((s) => where.status.in.includes(s.status))
      if (orderBy?.createdAt === 'desc') candidates = [...candidates].sort((a, b) => +b.createdAt - +a.createdAt)
      const s = candidates[0]
      if (!s) return null
      return project({ ...s, firstPaidAt: effectiveFirstPaidAt(s) }, select)
    },
    findMany: async ({ where, orderBy }: any) => {
      let candidates = where?.workspaceId ? (subs.get(where.workspaceId) ?? []) : flattenSubs()
      if (orderBy?.createdAt === 'desc') candidates = [...candidates].sort((a, b) => +b.createdAt - +a.createdAt)
      return candidates
    },
    upsert: async ({ where, create, update }: any) => {
      const arr = subs.get(where.workspaceId) ?? []
      const existing = arr[0]
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      const fresh: Sub = { id: `sub_${Math.random()}`, createdAt: new Date(), ...create }
      subs.set(where.workspaceId, [fresh])
      return fresh
    },
    update: async ({ where, data }: any) => {
      for (const arr of subs.values()) {
        const s = arr.find((x) => x.id === where.id)
        if (s) {
          Object.assign(s, data)
          return s
        }
      }
      throw new Error('sub not found')
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const arr of subs.values()) {
        for (const s of arr) {
          if (where.stripeCustomerId !== undefined && s.stripeCustomerId !== where.stripeCustomerId) continue
          if (where.firstPaidAt === null && effectiveFirstPaidAt(s) != null) continue
          Object.assign(s, data)
          count++
        }
      }
      return { count }
    },
  },
  usageWallet: {
    findUnique: async ({ where }: any) => wallets.get(where.workspaceId) ?? null,
    create: async ({ data }: any) => {
      const w: Wallet = {
        workspaceId: data.workspaceId,
        monthlyIncludedUsd: data.monthlyIncludedUsd ?? 0,
        monthlyIncludedAllocationUsd: data.monthlyIncludedAllocationUsd ?? 0,
        dailyIncludedUsd: data.dailyIncludedUsd ?? 0,
        dailyUsedThisMonthUsd: data.dailyUsedThisMonthUsd ?? 0,
        overageAccumulatedUsd: 0,
        overageBilledUsd: 0,
        overageEnabled: data.overageEnabled ?? false,
        overageHardLimitUsd: data.overageHardLimitUsd ?? null,
        overagePaidBlocks: 0,
        overageOutstandingInvoiceId: null,
        overageOutstandingUsd: 0,
        anniversaryDay: data.anniversaryDay,
        lastDailyReset: data.lastDailyReset,
        lastMonthlyReset: data.lastMonthlyReset,
        fiveHourWindowStart: data.fiveHourWindowStart ?? null,
        fiveHourUsedUsd: data.fiveHourUsedUsd ?? 0,
        weeklyWindowStart: data.weeklyWindowStart ?? null,
        weeklyUsedUsd: data.weeklyUsedUsd ?? 0,
        promoCreditUsd: data.promoCreditUsd ?? 0,
        promoCreditExpiresAt: data.promoCreditExpiresAt ?? null,
      }
      wallets.set(data.workspaceId, w)
      return w
    },
    update: async ({ where, data }: any) => {
      const w = wallets.get(where.workspaceId)
      if (!w) throw new Error('wallet not found')
      applyWalletData(w, data)
      return w
    },
    upsert: async ({ where, create, update }: any) => {
      const existing = wallets.get(where.workspaceId)
      if (existing) {
        applyWalletData(existing, update)
        return existing
      }
      return prismaApi.usageWallet.create({ data: create })
    },
    updateMany: async ({ where, data }: any) => {
      const w = wallets.get(where.workspaceId)
      const matches = w && Object.entries(where).every(([k, v]) => (w as any)[k] === v)
      if (!matches) return { count: 0 }
      applyWalletData(w!, data)
      return { count: 1 }
    },
  },
  workspaceGrant: {
    findMany: async ({ where }: any) => {
      const rows = grants.get(where.workspaceId) ?? []
      const now = where.startsAt?.lte ?? new Date()
      return rows.filter((r) => {
        if (+r.startsAt > +now) return false
        if (r.expiresAt && +r.expiresAt <= +now) return false
        return true
      })
    },
  },
  usageEvent: {
    create: async ({ data }: any) => {
      const ev = { id: `ue_${usageEvents.length + 1}`, createdAt: new Date(), ...data }
      usageEvents.push(ev)
      return ev
    },
    findMany: async ({ where, take, skip }: any) => {
      let rows = usageEvents.filter((e) => e.workspaceId === where.workspaceId)
      if (where?.projectId) rows = rows.filter((e) => e.projectId === where.projectId)
      if (where?.memberId) rows = rows.filter((e) => e.memberId === where.memberId)
      return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? 100))
    },
  },
  billingAccount: {
    findUnique: async ({ where }: any) => null,
    upsert: async ({ where, create }: any) => ({ workspaceId: where.workspaceId, ...create }),
  },
  member: {
    findFirst: async ({ where }: any) =>
      members.find(
        (m) =>
          (where.workspaceId === undefined || m.workspaceId === where.workspaceId) &&
          (where.userId === undefined || m.userId === where.userId) &&
          (where.role === undefined || m.role === where.role) &&
          (where.projectId === undefined || m.projectId === where.projectId),
      ) ?? null,
  },
  workspace: {
    findUnique: async ({ where }: any) => workspaces.get(where.id) ?? null,
    findMany: async () => Array.from(workspaces.values()),
    upsert: async ({ where, create, update }: any) => {
      const existing = workspaces.get(where.id)
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      const fresh = { id: where.id, ...create }
      workspaces.set(where.id, fresh)
      return fresh
    },
  },
  trialRedemption: {
    findUnique: async ({ where }: any) => {
      if (where.workspaceId) return redemptions.find((r) => r.workspaceId === where.workspaceId) ?? null
      if (where.cardFingerprint) return redemptions.find((r) => r.cardFingerprint === where.cardFingerprint) ?? null
      return null
    },
    findFirst: async ({ where }: any) => {
      const ors: any[] = where?.OR ?? []
      for (const clause of ors) {
        const hit = redemptions.find((r) => {
          if (clause.workspaceId !== undefined && r.workspaceId !== clause.workspaceId) return false
          if (clause.userId !== undefined && r.userId !== clause.userId) return false
          if (clause.cardFingerprint !== undefined && r.cardFingerprint !== clause.cardFingerprint) return false
          return true
        })
        if (hit) return hit
      }
      if (where?.userId !== undefined) {
        return (
          redemptions.find(
            (r) =>
              r.userId === where.userId &&
              (where.workspaceId?.not === undefined || r.workspaceId !== where.workspaceId.not),
          ) ?? null
        )
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
  },
  signupRiskAssessment: {
    findUnique: async () => null,
  },
  $transaction: async (fn: any) => fn(prismaApi),
}

function applyWalletData(w: Wallet, data: any) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as any)) {
      ;(w as any)[k] = ((w as any)[k] ?? 0) + (v as any).increment
    } else if (v && typeof v === 'object' && 'decrement' in (v as any)) {
      ;(w as any)[k] = ((w as any)[k] ?? 0) - (v as any).decrement
    } else {
      ;(w as any)[k] = v
    }
  }
}

mock.module('../../lib/prisma', () => ({
  prisma: prismaApi,
  SubscriptionStatus: { active: 'active', trialing: 'trialing', past_due: 'past_due', canceled: 'canceled' },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

mock.module('../../config/stripe-prices', () => ({
  ...realStripePrices,
  getOveragePriceConfig: () => ({ priceId: 'price_overage_x' }),
}))

// ============================================================================
// Stripe mock
// ============================================================================

const stripeCalls: Array<{ method: string; args: any[] }> = []
let cardOf: Record<string, { fingerprint: string | null; funding: string }> = {}

class FakeStripe {
  constructor(public key: string) {}
  invoiceItems = {
    create: async (a: any) => {
      stripeCalls.push({ method: 'invoiceItems.create', args: [a] })
      return { id: 'ii_1' }
    },
  }
  invoices = {
    create: async (a: any) => {
      stripeCalls.push({ method: 'invoices.create', args: [a] })
      return { id: 'in_1' }
    },
    finalizeInvoice: async (id: string) => {
      stripeCalls.push({ method: 'invoices.finalizeInvoice', args: [id] })
      return { id }
    },
    pay: async (id: string) => {
      stripeCalls.push({ method: 'invoices.pay', args: [id] })
      return { id }
    },
  }
  subscriptions = {
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'subscriptions.retrieve', args: [id] })
      const card = cardOf[id]
      return {
        id,
        default_payment_method: card
          ? { id: `pm_${id}`, type: 'card', card: { fingerprint: card.fingerprint, funding: card.funding } }
          : null,
        items: { data: [{ id: 'si_seat', price: { id: 'price_seat', recurring: { usage_type: 'licensed' } } }] },
      }
    },
    cancel: async (id: string) => {
      stripeCalls.push({ method: 'subscriptions.cancel', args: [id] })
      return { id, status: 'canceled' }
    },
  }
  subscriptionItems = {
    update: async (id: string, d: any) => {
      stripeCalls.push({ method: 'subscriptionItems.update', args: [id, d] })
      return {}
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe }))

const billing = await import('../billing.service')
const trial = await import('../trial.service')

// ============================================================================
// Fixtures
// ============================================================================

const today = new Date('2026-03-15T12:00:00Z')

function freshWallet(over: Partial<Wallet> = {}): Wallet {
  const now = new Date()
  return {
    workspaceId: 'w1',
    monthlyIncludedUsd: 20,
    monthlyIncludedAllocationUsd: 20,
    dailyIncludedUsd: 0.5,
    dailyUsedThisMonthUsd: 0,
    overageAccumulatedUsd: 0,
    overageBilledUsd: 0,
    overageEnabled: false,
    overageHardLimitUsd: null,
    overagePaidBlocks: 0,
    overageOutstandingInvoiceId: null,
    overageOutstandingUsd: 0,
    anniversaryDay: 1,
    lastDailyReset: now,
    lastMonthlyReset: now,
    fiveHourWindowStart: null,
    fiveHourUsedUsd: 0,
    weeklyWindowStart: null,
    weeklyUsedUsd: 0,
    promoCreditUsd: 0,
    promoCreditExpiresAt: null,
    ...over,
  }
}

/** Windows and promo both spent — the state the fraud trials reached. */
const exhausted = {
  overageEnabled: true,
  overageHardLimitUsd: null,
  fiveHourWindowStart: new Date(),
  fiveHourUsedUsd: 50,
  weeklyWindowStart: new Date(),
  weeklyUsedUsd: 50,
}

function setSub(over: Partial<Sub> & { workspaceId?: string } = {}): Sub {
  const workspaceId = over.workspaceId ?? 'w1'
  const s: Sub = {
    id: `sub_${workspaceId}`,
    workspaceId,
    stripeSubscriptionId: `stripe_${workspaceId}`,
    stripeCustomerId: `cus_${workspaceId}`,
    planId: 'pro',
    seats: 1,
    status: 'active',
    billingInterval: 'monthly',
    currentPeriodStart: today,
    currentPeriodEnd: today,
    cancelAtPeriodEnd: false,
    createdAt: today,
    ...over,
  }
  subs.set(workspaceId, [s])
  return s
}

/** A trialing subscription: a paid tier whose card has never been charged. */
function setTrialSub(over: Partial<Sub> = {}): Sub {
  return setSub({ status: 'trialing', firstPaidAt: null, ...over })
}

const origConsole = { log: console.log, warn: console.warn, error: console.error }

beforeEach(() => {
  subs.clear()
  wallets.clear()
  grants.clear()
  redemptions.length = 0
  members.length = 0
  workspaces.clear()
  usageEvents.length = 0
  stripeCalls.length = 0
  cardOf = {}
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  delete (process.env as any).STRIPE_SECRET_KEY
})

afterEach(() => {
  console.log = origConsole.log
  console.warn = origConsole.warn
  console.error = origConsole.error
  setSystemTime()
})

// ============================================================================
// AC1 — a trialing workspace never falls through to overage
// ============================================================================

describe('AC1: a trial cannot run up overage', () => {
  it('checkUsageBalance refuses with overage_requires_payment', async () => {
    setTrialSub()
    wallets.set('w1', freshWallet(exhausted))
    expect(await billing.checkUsageBalance('w1', 1)).toEqual({
      ok: false,
      reason: 'overage_requires_payment',
    })
  })

  it('consumeUsage refuses, records no overage, and leaves the toggle on', async () => {
    setTrialSub()
    wallets.set('w1', freshWallet(exhausted))
    const r = await billing.consumeUsage({
      workspaceId: 'w1',
      projectId: null,
      memberId: 'u1',
      actionType: 'chat_message',
      billedUsd: 5,
    })
    expect(r.success).toBe(false)
    expect(r.reason).toBe('overage_requires_payment')
    const w = wallets.get('w1')!
    expect(w.overageAccumulatedUsd).toBe(0)
    // The user's setting is not healed away: it switches on after the first payment.
    expect(w.overageEnabled).toBe(true)
  })

  it('chargeOverageBlocks returns 0 and never touches Stripe', async () => {
    // With a key set the function gets past its own "no Stripe" early return,
    // so this exercises the firstPaidAt guard rather than the missing key.
    process.env.STRIPE_SECRET_KEY = 'sk_test_409'
    setTrialSub()
    wallets.set('w1', freshWallet({ ...exhausted, overageAccumulatedUsd: 30, overageBilledUsd: 0 }))
    expect(await billing.chargeOverageBlocks('w1')).toBe(0)
    expect(stripeCalls).toEqual([])
  })

  it('getOverageStatus reports overageActive false so the UI does not claim it is on', async () => {
    setTrialSub()
    wallets.set('w1', freshWallet({ overageEnabled: true }))
    expect(await billing.getOverageStatus('w1')).toEqual({
      overageEnabled: true,
      paidTier: true,
      overageTrusted: false,
      overageActive: false,
    })
  })

  it('the refusal carries a message the client can show', () => {
    const payload = billing.usageLimitErrorPayload('overage_requires_payment')
    expect(payload.code).toBe('overage_requires_payment')
    expect(payload.message).toContain('On-demand usage starts after your first payment')
  })
})

// ============================================================================
// AC2 — the trial still gets its plan windows and promo credit
// ============================================================================

describe('AC2: the trial keeps its windows and promo credit', () => {
  it('plan windows still admit usage while trialing', async () => {
    setTrialSub()
    wallets.set('w1', freshWallet({ overageEnabled: true }))
    expect(await billing.checkUsageBalance('w1', 1)).toEqual({ ok: true })
    const r = await billing.consumeUsage({
      workspaceId: 'w1',
      projectId: null,
      memberId: 'u1',
      actionType: 'chat_message',
      billedUsd: 1,
    })
    expect(r.success).toBe(true)
    expect(r.source).toBe('window')
  })

  it('promo credit still covers a call once the windows are spent', async () => {
    setTrialSub()
    wallets.set(
      'w1',
      freshWallet({
        ...exhausted,
        promoCreditUsd: 10,
        promoCreditExpiresAt: new Date(Date.now() + 86_400_000),
      }),
    )
    expect(await billing.checkUsageBalance('w1', 1)).toEqual({ ok: true })
    const r = await billing.consumeUsage({
      workspaceId: 'w1',
      projectId: null,
      memberId: 'u1',
      actionType: 'chat_message',
      billedUsd: 2,
    })
    expect(r.success).toBe(true)
    expect(r.source).toBe('promo')
    expect(wallets.get('w1')!.overageAccumulatedUsd).toBe(0)
  })
})

// ============================================================================
// AC3 — only a real payment unlocks overage
// ============================================================================

describe('AC3: firstPaidAt comes from a real invoice', () => {
  it('a paid invoice sets it', async () => {
    setTrialSub()
    expect(await billing.markSubscriptionFirstPaid('cus_w1', 2500)).toBe(1)
    expect(subs.get('w1')![0].firstPaidAt).toBeInstanceOf(Date)
  })

  it("a $0 trial invoice does not", async () => {
    setTrialSub()
    expect(await billing.markSubscriptionFirstPaid('cus_w1', 0)).toBe(0)
    expect(subs.get('w1')![0].firstPaidAt).toBeNull()
  })

  it('a webhook retry does not move an already-set firstPaidAt', async () => {
    setTrialSub()
    await billing.markSubscriptionFirstPaid('cus_w1', 2500)
    const first = subs.get('w1')![0].firstPaidAt
    expect(await billing.markSubscriptionFirstPaid('cus_w1', 2500)).toBe(0)
    expect(subs.get('w1')![0].firstPaidAt).toBe(first)
  })

  it('overage works once the card has paid', async () => {
    setTrialSub()
    wallets.set('w1', freshWallet(exhausted))
    await billing.markSubscriptionFirstPaid('cus_w1', 2500)
    const r = await billing.consumeUsage({
      workspaceId: 'w1',
      projectId: null,
      memberId: 'u1',
      actionType: 'chat_message',
      billedUsd: 5,
    })
    expect(r.success).toBe(true)
    expect(r.source).toBe('overage')
    expect(wallets.get('w1')!.overageAccumulatedUsd).toBe(5)
  })
})

// ============================================================================
// AC4 — existing payers and grant-only workspaces are unchanged
// ============================================================================

describe('AC4: existing payers behave exactly as today', () => {
  it('an active subscription with a backfilled firstPaidAt keeps overage', async () => {
    setSub({ status: 'active', firstPaidAt: today })
    wallets.set('w1', freshWallet(exhausted))
    expect(await billing.checkUsageBalance('w1', 1)).toEqual({ ok: true })
    const r = await billing.consumeUsage({
      workspaceId: 'w1',
      projectId: null,
      memberId: 'u1',
      actionType: 'chat_message',
      billedUsd: 5,
    })
    expect(r.success).toBe(true)
    expect(r.source).toBe('overage')
  })

  it('a grant-only paid workspace (no subscription) is still trusted', async () => {
    grants.set('w1', [
      {
        id: 'g1',
        workspaceId: 'w1',
        freeSeats: 1,
        monthlyIncludedUsd: 20,
        planId: 'pro',
        startsAt: new Date(0),
        expiresAt: null,
      },
    ])
    wallets.set('w1', freshWallet(exhausted))
    expect(await billing.getOverageStatus('w1')).toMatchObject({ paidTier: true, overageTrusted: true })
    const r = await billing.consumeUsage({
      workspaceId: 'w1',
      projectId: null,
      memberId: 'u1',
      actionType: 'chat_message',
      billedUsd: 5,
    })
    expect(r.success).toBe(true)
    expect(r.source).toBe('overage')
  })
})

// ============================================================================
// AC5 — a prepaid card cannot start a trial
// ============================================================================

describe('AC5: prepaid cards are refused at trial start', () => {
  beforeEach(() => {
    members.push({ workspaceId: 'w1', userId: 'u1', role: 'owner', projectId: null })
  })

  it('cancels the subscription and records blocked_prepaid_card', async () => {
    cardOf['sub_pre'] = { fingerprint: 'fp_pre', funding: 'prepaid' }
    const outcome = await trial.recordTrialStart({
      stripe: new FakeStripe('sk') as any,
      workspaceId: 'w1',
      userId: 'u1',
      planId: 'pro',
      subscriptionId: 'sub_pre',
      stripeCustomerId: 'cus_pre',
    })
    expect(outcome).toBe('blocked')
    expect(stripeCalls.map((c) => c.method)).toContain('subscriptions.cancel')
    expect(redemptions.find((r) => r.workspaceId === 'w1')!.status).toBe('blocked_prepaid_card')
    // The webhook reads this to tell the owner *why*.
    expect(await trial.getTrialBlockStatus('w1')).toBe('blocked_prepaid_card')
  })

  it('a credit card is recorded as today', async () => {
    cardOf['sub_ok'] = { fingerprint: 'fp_ok', funding: 'credit' }
    const outcome = await trial.recordTrialStart({
      stripe: new FakeStripe('sk') as any,
      workspaceId: 'w1',
      userId: 'u1',
      planId: 'pro',
      subscriptionId: 'sub_ok',
      stripeCustomerId: 'cus_ok',
    })
    expect(outcome).toBe('recorded')
    expect(stripeCalls.map((c) => c.method)).not.toContain('subscriptions.cancel')
    expect(redemptions.find((r) => r.workspaceId === 'w1')!.status).toBe('trialing')
  })

  it('a debit card is recorded as today', async () => {
    cardOf['sub_deb'] = { fingerprint: 'fp_deb', funding: 'debit' }
    const outcome = await trial.recordTrialStart({
      stripe: new FakeStripe('sk') as any,
      workspaceId: 'w1',
      userId: 'u1',
      planId: 'pro',
      subscriptionId: 'sub_deb',
      stripeCustomerId: 'cus_deb',
    })
    expect(outcome).toBe('recorded')
  })
})

// ============================================================================
// AC6 — trial checkout asks the issuer to authenticate the card
// ============================================================================

describe('AC6: 3D Secure on trial checkout only', () => {
  it('a trial checkout requests 3DS', () => {
    const p = trial.trialCheckoutParams(7, { workspaceId: 'w1' })
    expect(p.payment_method_options).toEqual({ card: { request_three_d_secure: 'any' } })
  })

  it('a paid checkout is unchanged', () => {
    expect(trial.trialCheckoutParams(0, { workspaceId: 'w1' })).toEqual({})
  })

  it('buildCheckoutTrialFields passes it through for a trial', async () => {
    const fields = await trial.buildCheckoutTrialFields({
      wantsTrial: true,
      planId: 'business',
      workspaceId: 'w1',
      userId: 'u1',
      affiliate: { subscription_data: { metadata: {} } },
    } as any)
    expect(fields.payment_method_options).toEqual({ card: { request_three_d_secure: 'any' } })
  })
})
