// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-440: one trial per network, and a device id for
 * Google/Apple sign-ups.
 *
 * The fraud (Nov 18): four accounts on one IP `118.99.73.148`. Three used Google
 * sign-in and each started a Business trial on a different HK Visa card. The
 * three Google accounts scored 0-5 (low) because OAuth sign-ups recorded no
 * device id and the -15 trusted-provider credit cancelled the IP match. The one
 * credential account scored 80 (high) on a device match, and it sat inside
 * another account's trial workspace. Every existing check (one trial per user,
 * workspace and card, no prepaid, 3DS) passed because the account and the card
 * changed each time.
 *
 * These cover the acceptance criteria end to end against the real services with
 * an independent prisma double:
 *   AC1 — the four Nov 18 accounts: trial 1 eligible, trials 2-4 refused, each
 *         with the `detail` that fired.
 *   AC2 — a clean Google sign-up on a new network still gets a trial.
 *   AC3 — the -15 credit is withheld when a linking signal fired.
 *   AC4 — the device id comes from the `shogo.device_id` cookie when the header
 *         is absent; the header wins; invalid values are ignored.
 *   AC5 — the parallel-checkout backstop blocks with `blocked_duplicate_network`,
 *         cancels the subscription and never allocates the wallet.
 *   AC6 — every trial-eligibility caller passes the checkout request, so the
 *         trial button follows the same answer.
 *   AC7 — the checkout re-score never writes the signup assessment.
 *
 * Stripe is mocked throughout: no network, no real charge.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

// ============================================================================
// In-memory prisma double
// ============================================================================

type Row = Record<string, any>

const redemptions: Row[] = []
const subscriptions: Row[] = []
const assessments = new Map<string, Row>()
const members: Row[] = []
const users: Row[] = []

/** Prisma `where` semantics for the operators these paths use. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((clause) => matches(row, clause))
    if (key === 'NOT') return !matches(row, cond as Row)
    const actual = row[key] ?? null
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('not' in cond) return actual !== cond.not
      if ('in' in cond) return (cond.in as unknown[]).includes(actual)
      if ('gte' in cond) return actual != null && new Date(actual) >= new Date(cond.gte)
      if ('lte' in cond) return actual != null && new Date(actual) <= new Date(cond.lte)
    }
    return actual === cond
  })
}

const assessmentRows = () => [...assessments.entries()].map(([userId, row]) => ({ userId, ...row }))

const prismaApi: any = {
  trialRedemption: {
    findFirst: async ({ where }: any) => redemptions.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: any) => redemptions.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: any) => redemptions.filter((r) => matches(r, where)),
    upsert: async ({ where, create, update }: any) => {
      const existing = redemptions.find((r) => matches(r, where))
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      const fresh = { ...create }
      redemptions.push(fresh)
      return fresh
    },
  },
  subscription: {
    findFirst: async ({ where }: any) => subscriptions.find((s) => matches(s, where)) ?? null,
  },
  signupRiskAssessment: {
    // SHO-459: banned-linked count resolves linked ids first.
    findMany: async () => [],
    findUnique: async ({ where }: any) => assessments.get(where.userId) ?? null,
    findFirst: async ({ where }: any) => assessmentRows().find((r) => matches(r, where)) ?? null,
    count: async ({ where }: any) => assessmentRows().filter((r) => matches(r, where)).length,
  },
  member: {
    findFirst: async ({ where }: any) => members.find((m) => matches(m, where)) ?? null,
    findMany: async ({ where }: any) => members.filter((m) => matches(m, where)),
  },
  user: {
    findUnique: async ({ where }: any) => users.find((u) => matches(u, where)) ?? null,
    count: async ({ where }: any) => users.filter((u) => matches(u, where)).length,
  },
}

mock.module('../../lib/prisma', () => ({
  prisma: prismaApi,
  SubscriptionStatus: { active: 'active', trialing: 'trialing', past_due: 'past_due', canceled: 'canceled' },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

const trial = await import('../trial.service')
const risk = await import('../signup-risk.service')
const { scoreSignupRisk } = await import('../signup-risk-scoring')

// ============================================================================
// Stripe double
// ============================================================================

const stripeCalls: Array<{ method: string; args: any[] }> = []
let cardOf: Record<string, { fingerprint: string | null; funding: string }> = {}

const stripe: any = {
  subscriptions: {
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'subscriptions.retrieve', args: [id] })
      const card = cardOf[id] ?? { fingerprint: `fp_${id}`, funding: 'credit' }
      return {
        id,
        default_payment_method: { type: 'card', card: { fingerprint: card.fingerprint, funding: card.funding } },
      }
    },
    cancel: async (id: string) => {
      stripeCalls.push({ method: 'subscriptions.cancel', args: [id] })
      return { id, status: 'canceled' }
    },
  },
  invoices: {
    create: async (params: any) => {
      stripeCalls.push({ method: 'invoices.create', args: [params] })
      return { id: 'in_should_not_exist' }
    },
  },
}

// ============================================================================
// Fixtures
// ============================================================================

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

function account(params: {
  id: string
  email: string
  band: 'low' | 'medium' | 'high'
  provider: 'social' | 'credential'
  ipPrefix?: string | null
  deviceId?: string | null
  reviewDecision?: string | null
  createdAt?: Date
}) {
  users.push({ id: params.id, email: params.email, emailVerified: true, emailCanonical: params.email })
  assessments.set(params.id, {
    band: params.band,
    ipPrefix: params.ipPrefix === undefined ? FARM_IP : params.ipPrefix,
    deviceId: params.deviceId ?? null,
    signals: { provider: params.provider },
    reviewDecision: params.reviewDecision ?? null,
    createdAt: params.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
  })
}

beforeEach(() => {
  redemptions.length = 0
  subscriptions.length = 0
  assessments.clear()
  members.length = 0
  users.length = 0
  stripeCalls.length = 0
  cardOf = {}
})

// ============================================================================
// AC1 — the four Nov 18 accounts
// ============================================================================

describe('AC1: the Nov 18 farm, reproduced', () => {
  function seedFarm() {
    account({ id: 'u-google-1', email: 'pasipalapasi9@gmail.com', band: 'low', provider: 'social' })
    account({ id: 'u-google-2', email: 'burhannudinaps@gmail.com', band: 'low', provider: 'social' })
    account({ id: 'u-google-3', email: 'wicakwicak39@students.unnes.ac.id', band: 'low', provider: 'social' })
    account({
      id: 'u-cred',
      email: 'cioganteng@my.id',
      band: 'high',
      provider: 'credential',
      deviceId: 'dev-shared-0001',
    })
    // One workspace per account; the high-risk credential account is a member of
    // burhannudinaps's workspace, exactly as it was on Nov 18.
    members.push({ userId: 'u-google-1', workspaceId: 'ws-1', role: 'owner', projectId: null })
    members.push({ userId: 'u-google-2', workspaceId: 'ws-2', role: 'owner', projectId: null })
    members.push({ userId: 'u-google-3', workspaceId: 'ws-3', role: 'owner', projectId: null })
    members.push({ userId: 'u-cred', workspaceId: 'ws-4', role: 'owner', projectId: null })
    members.push({ userId: 'u-cred', workspaceId: 'ws-2', role: 'member', projectId: null })
  }

  it('trial 1 is eligible, trials 2-4 are refused with the detail that fired', async () => {
    seedFarm()

    const first = await trial.trialEligibility({
      userId: 'u-google-1',
      workspaceId: 'ws-1',
      planId: 'business',
      request: request(),
    })
    expect(first.eligible).toBe(true)
    // The IP cluster is no longer cancelled by the Google credit: 4 accounts on
    // the IP is +40, medium, so the first trial still goes through.
    expect(first.checkoutRiskScore).toBe(40)
    redemptions.push({ userId: 'u-google-1', workspaceId: 'ws-1', status: 'trialing', createdAt: new Date() })

    // Trial 2: the workspace holds the high-risk credential account.
    expect(
      await trial.trialEligibility({
        userId: 'u-google-2',
        workspaceId: 'ws-2',
        planId: 'business',
        request: request(),
      }),
    ).toMatchObject({ eligible: false, reason: 'risk_review', detail: 'member_high_risk' })

    // Trial 3: no high-risk member, but the network already has a trial.
    expect(
      await trial.trialEligibility({
        userId: 'u-google-3',
        workspaceId: 'ws-3',
        planId: 'business',
        request: request(),
      }),
    ).toMatchObject({ eligible: false, reason: 'risk_review', detail: 'network_trial_used' })

    // Trial 4: the credential account is high risk on its own signup score.
    expect(
      await trial.trialEligibility({
        userId: 'u-cred',
        workspaceId: 'ws-4',
        planId: 'business',
        request: request(),
      }),
    ).toMatchObject({ eligible: false, reason: 'risk_review' })
  })

  it('a trial on the same device is refused even from a different IP', async () => {
    account({ id: 'u-a', email: 'a@example.com', band: 'low', provider: 'credential', ipPrefix: '198.51.100.1', deviceId: 'dev-shared-0002' })
    account({ id: 'u-b', email: 'b@example.com', band: 'low', provider: 'credential', ipPrefix: '198.51.100.2', deviceId: 'dev-shared-0002' })
    members.push({ userId: 'u-b', workspaceId: 'ws-b', role: 'owner', projectId: null })
    redemptions.push({ userId: 'u-a', workspaceId: 'ws-a', status: 'ended', createdAt: new Date() })

    // No checkout request at all: the buyer's own signup device is the match.
    expect(
      await trial.trialEligibility({ userId: 'u-b', workspaceId: 'ws-b', planId: 'business' }),
    ).toMatchObject({ eligible: false, reason: 'risk_review', detail: 'network_trial_used' })
  })

  it('a trial older than the 30-day window does not block the network', async () => {
    account({ id: 'u-old', email: 'old@example.com', band: 'low', provider: 'credential', ipPrefix: '198.51.100.7' })
    account({ id: 'u-new', email: 'new@example.com', band: 'low', provider: 'credential', ipPrefix: '198.51.100.7' })
    members.push({ userId: 'u-new', workspaceId: 'ws-new', role: 'owner', projectId: null })
    redemptions.push({
      userId: 'u-old',
      workspaceId: 'ws-old',
      status: 'ended',
      createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    })

    const result = await trial.trialEligibility({
      userId: 'u-new',
      workspaceId: 'ws-new',
      planId: 'business',
      request: request({ ip: '198.51.100.7', ipPrefix: '198.51.100.7' }),
    })
    expect(result.eligible).toBe(true)
  })

  it('a high-risk member cleared by an admin review does not block the trial', async () => {
    account({ id: 'u-owner', email: 'owner@example.com', band: 'low', provider: 'credential', ipPrefix: '192.0.2.5' })
    account({
      id: 'u-reviewed',
      email: 'reviewed@example.com',
      band: 'high',
      provider: 'credential',
      ipPrefix: '192.0.2.6',
      reviewDecision: 'approved',
    })
    members.push({ userId: 'u-owner', workspaceId: 'ws-owner', role: 'owner', projectId: null })
    members.push({ userId: 'u-reviewed', workspaceId: 'ws-owner', role: 'member', projectId: null })

    const result = await trial.trialEligibility({
      userId: 'u-owner',
      workspaceId: 'ws-owner',
      planId: 'business',
      request: request({ ip: '192.0.2.5', ipPrefix: '192.0.2.5' }),
    })
    expect(result.eligible).toBe(true)
  })
})

// ============================================================================
// AC2 — a clean Google sign-up still gets a trial
// ============================================================================

describe('AC2: a clean Google sign-up is unaffected', () => {
  it('new IP, new device, no members: eligible, and the -15 still applies', async () => {
    account({
      id: 'u-clean',
      email: 'clean@gmail.com',
      band: 'low',
      provider: 'social',
      ipPrefix: '203.0.113.9',
      deviceId: 'dev-clean-0001',
    })
    members.push({ userId: 'u-clean', workspaceId: 'ws-clean', role: 'owner', projectId: null })

    const result = await trial.trialEligibility({
      userId: 'u-clean',
      workspaceId: 'ws-clean',
      planId: 'business',
      request: request({ ip: '203.0.113.9', ipPrefix: '203.0.113.9', deviceId: 'dev-clean-0001' }),
    })
    expect(result.eligible).toBe(true)
    // Nothing links this account to another one, so the trusted-provider credit
    // is kept and the checkout re-score is 0.
    expect(result.checkoutRiskScore).toBe(0)
  })
})

// ============================================================================
// AC3 — the trusted-provider credit is withheld when a linking signal fired
// ============================================================================

describe('AC3: the -15 no longer cancels a linking signal', () => {
  const base = {
    email: 'someone@gmail.com',
    provider: 'social' as const,
    emailVerified: true,
    allowlisted: false,
    canonicalCollisions: 0,
    deviceLinkedAccounts: 0,
    ipLinkedAccounts: 0,
    burstSignups: 0,
  }

  it('a social sign-up on a 2-account IP scores 20, not 5, and has no trusted-provider signal', () => {
    const result = scoreSignupRisk({ ...base, ipLinkedAccounts: 1 })
    expect(result.score).toBe(20)
    expect(result.signals.map((s) => s.name)).toContain('ip_cluster_2plus')
    expect(result.signals.map((s) => s.name)).not.toContain('trusted_oauth_provider')
  })

  it('a social sign-up on a 4+ account IP scores 40, not 25', () => {
    const result = scoreSignupRisk({ ...base, ipLinkedAccounts: 3 })
    expect(result.score).toBe(40)
    expect(result.signals.map((s) => s.name)).not.toContain('trusted_oauth_provider')
  })

  it('a device match also withholds the credit', () => {
    const result = scoreSignupRisk({ ...base, deviceLinkedAccounts: 1 })
    expect(result.signals.map((s) => s.name)).not.toContain('trusted_oauth_provider')
  })

  it('a clean social sign-up keeps the credit', () => {
    const result = scoreSignupRisk(base)
    expect(result.signals.map((s) => s.name)).toContain('trusted_oauth_provider')
    expect(result.score).toBe(0)
    expect(result.decision).toBe('credit_full')
  })
})

// ============================================================================
// AC4 — the device id survives the OAuth redirect in a first-party cookie
// ============================================================================

describe('AC4: the device id comes from the cookie when the header is absent', () => {
  const DEVICE = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

  it('reads the cookie on the OAuth callback, where no header can be sent', () => {
    const info = risk.readSignupRequestInfo({
      cookie: `other=1; shogo.device_id=${DEVICE}; theme=dark`,
      'x-forwarded-for': '118.99.73.148',
    })
    expect(info.deviceId).toBe(DEVICE)
    expect(info.ipPrefix).toBe('118.99.73.148')
  })

  it('the header beats the cookie', () => {
    const info = risk.readSignupRequestInfo({
      cookie: `shogo.device_id=${DEVICE}`,
      'x-shogo-device-id': 'header-device-0001',
    })
    expect(info.deviceId).toBe('header-device-0001')
  })

  it('an invalid cookie value is ignored', () => {
    const info = risk.readSignupRequestInfo({ cookie: 'shogo.device_id=bad value!' })
    expect(info.deviceId).toBeNull()
  })

  it('an invalid header falls back to a valid cookie', () => {
    const info = risk.readSignupRequestInfo({
      cookie: `shogo.device_id=${DEVICE}`,
      'x-shogo-device-id': 'short',
    })
    expect(info.deviceId).toBe(DEVICE)
  })
})

// ============================================================================
// AC5 — the parallel-checkout backstop
// ============================================================================

describe('AC5: two checkouts on one network, the second is blocked', () => {
  it('blocks with blocked_duplicate_network, cancels the subscription, allocates no wallet', async () => {
    account({ id: 'u-1', email: 'one@example.com', band: 'low', provider: 'credential' })
    account({ id: 'u-2', email: 'two@example.com', band: 'low', provider: 'credential' })
    members.push({ userId: 'u-2', workspaceId: 'ws-2', role: 'owner', projectId: null })
    // The first checkout completed and recorded its trial before the second
    // webhook arrived — both had already passed the checkout-time check.
    redemptions.push({ userId: 'u-1', workspaceId: 'ws-1', status: 'trialing', createdAt: new Date() })
    cardOf['sub_2'] = { fingerprint: 'fp_network', funding: 'credit' }

    const outcome = await trial.recordTrialStart({
      stripe,
      workspaceId: 'ws-2',
      userId: 'u-2',
      planId: 'business',
      subscriptionId: 'sub_2',
      stripeCustomerId: 'cus_2',
    })

    expect(outcome).toBe('blocked')
    expect(stripeCalls.map((c) => c.method)).toContain('subscriptions.cancel')
    expect(stripeCalls.find((c) => c.method === 'subscriptions.cancel')!.args[0]).toBe('sub_2')
    // No invoice: the caller must not allocate the wallet on 'blocked'.
    expect(stripeCalls.map((c) => c.method)).not.toContain('invoices.create')
    expect(redemptions.find((r) => r.workspaceId === 'ws-2')!.status).toBe('blocked_duplicate_network')
    expect(await trial.getTrialBlockStatus('ws-2')).toBe('blocked_duplicate_network')
  })

  it('a different network is recorded normally', async () => {
    account({ id: 'u-1', email: 'one@example.com', band: 'low', provider: 'credential' })
    account({ id: 'u-2', email: 'two@example.com', band: 'low', provider: 'credential', ipPrefix: '203.0.113.200' })
    members.push({ userId: 'u-2', workspaceId: 'ws-2', role: 'owner', projectId: null })
    redemptions.push({ userId: 'u-1', workspaceId: 'ws-1', status: 'trialing', createdAt: new Date() })
    cardOf['sub_2'] = { fingerprint: 'fp_other', funding: 'credit' }

    const outcome = await trial.recordTrialStart({
      stripe,
      workspaceId: 'ws-2',
      userId: 'u-2',
      planId: 'business',
      subscriptionId: 'sub_2',
      stripeCustomerId: 'cus_2',
    })

    expect(outcome).toBe('recorded')
    expect(stripeCalls.map((c) => c.method)).not.toContain('subscriptions.cancel')
  })
})

// ============================================================================
// AC6 — every caller passes the checkout request, so the trial button follows
// ============================================================================

describe('AC6: the trial button follows the same answer', () => {
  it('all three trial-eligibility call sites pass the checkout request', async () => {
    const source = await Bun.file(new URL('../../server.ts', import.meta.url)).text()
    // `/api/billing/workspace-plan` calls it directly; the two checkout routes
    // reach it through `buildCheckoutTrialFields`.
    const calls = source.match(/trialEligibility\(\{[\s\S]*?\}\)/g) ?? []
    expect(calls).toHaveLength(1)
    for (const call of calls) {
      expect(call).toContain('readSignupRequestInfo(c.req.raw.headers)')
    }
    // The seat-plan checkout reaches it through buildCheckoutTrialFields.
    const checkoutCalls = source.match(/buildCheckoutTrialFields\(\{[\s\S]*?\}\)/g) ?? []
    expect(checkoutCalls.length).toBeGreaterThanOrEqual(2)
    for (const call of checkoutCalls) {
      expect(call).toContain('readSignupRequestInfo(c.req.raw.headers)')
    }
  })
})

// ============================================================================
// AC7 — the checkout re-score never writes the signup assessment
// ============================================================================

describe('AC7: signup credit is unchanged by the checkout re-score', () => {
  it('a refused checkout leaves the assessment row byte-identical', async () => {
    account({ id: 'u-sneaky', email: 'sneaky@example.com', band: 'low', provider: 'social', ipPrefix: '203.0.113.50' })
    members.push({ userId: 'u-sneaky', workspaceId: 'ws-sneaky', role: 'owner', projectId: null })
    // Four other accounts already signed up from the checkout IP, just now:
    // ip_cluster_4plus (40) + signup_burst_10m (20) = 60, high.
    for (let i = 0; i < 4; i++) {
      account({
        id: `u-other-${i}`,
        email: `other${i}@example.com`,
        band: 'low',
        provider: 'credential',
        ipPrefix: '203.0.113.99',
        createdAt: new Date(),
      })
    }
    const before = JSON.stringify(assessments.get('u-sneaky'))

    const result = await trial.trialEligibility({
      userId: 'u-sneaky',
      workspaceId: 'ws-sneaky',
      planId: 'business',
      request: request({ ip: '203.0.113.99', ipPrefix: '203.0.113.99' }),
    })

    expect(result).toMatchObject({ eligible: false, reason: 'risk_review', detail: 'checkout_high_risk' })
    expect(JSON.stringify(assessments.get('u-sneaky'))).toBe(before)
  })
})
