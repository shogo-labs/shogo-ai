// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Signup promo credit: staged grants are idempotent, verification releases
 * exactly once, high-risk rescoring blocks release, and expiry zeroes the
 * balance with an audit event. Prisma is an in-memory double that understands
 * the operators the service uses (equality, gt/gte/lt/lte, in, increment,
 * decrement).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type Row = Record<string, any>
const DAY = 24 * 60 * 60 * 1000

const wallets = new Map<string, Row>()
const members: Row[] = []
const assessments = new Map<string, Row>()
const users = new Map<string, Row>()
const usageEvents: Row[] = []
let homeFilter: Set<string> | null = null

function num(x: any) {
  return x instanceof Date ? x.getTime() : x
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR' || k === 'NOT' || k === 'AND') return true
    const actual = row[k] ?? null
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const a = num(actual)
      // Every operator in the object must hold (e.g. { gt: 0, lt: 2 }).
      return Object.entries(v).every(([op, arg]) => {
        if (op === 'gt') return a !== null && a > num(arg)
        if (op === 'gte') return a !== null && a >= num(arg)
        if (op === 'lt') return a !== null && a < num(arg)
        if (op === 'lte') return a !== null && a <= num(arg)
        if (op === 'in') return (arg as any[]).includes(actual)
        if (op === 'not') return actual !== arg
        return true
      })
    }
    if (v === null) return actual === null
    return num(actual) === num(v)
  })
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('increment' in v) row[k] = (row[k] ?? 0) + v.increment
      else if ('decrement' in v) row[k] = (row[k] ?? 0) - v.decrement
      else row[k] = v
    } else {
      row[k] = v
    }
  }
}

function newWallet(workspaceId: string): Row {
  const w: Row = {
    workspaceId,
    promoCreditUsd: 0,
    promoCreditGrantedUsd: 0,
    promoCreditStage: 0,
    promoCreditExpiresAt: null,
    overageEnabled: false,
    dailyIncludedUsd: 1,
  }
  wallets.set(workspaceId, w)
  return w
}

const prismaDouble: Record<string, any> = {
  $transaction: async (fn: (tx: any) => Promise<any>) => fn(prismaDouble),
  member: {
    findFirst: async ({ where }: { where: Row }) =>
      members.find((m) => matches(m, where)) ?? null,
  },
  usageWallet: {
    findUnique: async ({ where }: { where: Row }) => wallets.get(where.workspaceId) ?? null,
    findMany: async ({ where }: { where: Row; take?: number }) =>
      [...wallets.values()].filter((w) => matches(w, where)),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = [...wallets.values()].filter((w) => matches(w, where))
      rows.forEach((w) => applyData(w, data))
      return { count: rows.length }
    },
  },
  signupRiskAssessment: {
    findUnique: async ({ where }: { where: Row }) => {
      const a = assessments.get(where.userId)
      return a ? { ...a } : null
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const a = assessments.get(where.userId)
      if (a) applyData(a, data)
      return { count: a ? 1 : 0 }
    },
  },
  user: {
    findUnique: async ({ where }: { where: Row }) => {
      const u = users.get(where.id)
      return u ? { ...u } : null
    },
  },
  usageEvent: {
    create: async ({ data }: { data: Row }) => {
      usageEvents.push({ ...data })
      return data
    },
  },
}

mock.module('../../lib/prisma', () => ({ prisma: prismaDouble }))
mock.module('../billing.service', () => ({
  allocateFreeWallet: async (workspaceId: string) => wallets.get(workspaceId) ?? newWallet(workspaceId),
}))
mock.module('../../lib/region', () => ({
  homeWorkspaceIds: async (ids: string[]) =>
    homeFilter === null ? null : new Set(ids.filter((id) => homeFilter!.has(id))),
}))

const recorded: Array<{ userId: string; decision?: string }> = []
const riskState = { features: null as any }
mock.module('../signup-risk.service', () => ({
  collectSignupRiskFeatures: async () => riskState.features,
  recordSignupRiskAssessment: async (params: { userId: string; decision?: string; result: any }) => {
    recorded.push({ userId: params.userId, decision: params.decision ?? params.result.decision })
    const a = assessments.get(params.userId)
    if (a) a.decision = params.decision ?? params.result.decision
  },
}))

const credit = await import('../signup-credit.service')
const { CREDIT_DECISIONS } = credit
const { scoreSignupRisk } = await import('../signup-risk-scoring')

const CLEAN = {
  email: 'alice@company.io',
  provider: 'credential' as const,
  emailVerified: true,
  allowlisted: false,
  canonicalCollisions: 0,
  deviceLinkedAccounts: 0,
  ipLinkedAccounts: 0,
  burstSignups: 0,
}

beforeEach(() => {
  wallets.clear()
  members.length = 0
  assessments.clear()
  users.clear()
  usageEvents.length = 0
  recorded.length = 0
  homeFilter = null
  riskState.features = { ...CLEAN }
  members.push({ userId: 'u-1', workspaceId: 'ws-1', role: 'owner', projectId: null, createdAt: new Date(0) })
  users.set('u-1', { id: 'u-1', email: 'alice@company.io', emailVerified: false })
})

function seedAssessment(decision: string, email = 'alice@company.io') {
  const result = scoreSignupRisk({ ...CLEAN, email, emailVerified: false })
  assessments.set('u-1', {
    userId: 'u-1',
    decision,
    band: result.band,
    score: result.score,
    signals: { provider: 'credential', allowlisted: false },
    ip: '203.0.113.9',
    ipPrefix: null,
    deviceId: null,
    emailCanonical: 'alice@company.io',
    country: 'US',
  })
}

describe('grantPromoCredit (staged, idempotent)', () => {
  test('first stage grant adds the amount and anchors the expiry to now + 30 days', async () => {
    const now = new Date('2026-10-01T00:00:00Z')
    const changed = await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1, now })
    expect(changed).toBe(true)
    const w = wallets.get('ws-1')!
    expect(w.promoCreditUsd).toBe(2)
    expect(w.promoCreditStage).toBe(1)
    expect(new Date(w.promoCreditExpiresAt).getTime()).toBe(now.getTime() + 30 * DAY)
  })

  test('repeating the same stage grants nothing (retry-safe)', async () => {
    const now = new Date('2026-10-01T00:00:00Z')
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1, now })
    const again = await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1, now })
    expect(again).toBe(false)
    expect(wallets.get('ws-1')!.promoCreditUsd).toBe(2)
  })

  test('the verification stage adds the rest without moving the expiry', async () => {
    const t0 = new Date('2026-10-01T00:00:00Z')
    const t1 = new Date('2026-10-05T00:00:00Z')
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1, now: t0 })
    const expiry = wallets.get('ws-1')!.promoCreditExpiresAt
    const changed = await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 8, toStage: 2, now: t1 })
    expect(changed).toBe(true)
    const w = wallets.get('ws-1')!
    expect(w.promoCreditUsd).toBe(10)
    expect(w.promoCreditGrantedUsd).toBe(10)
    expect(w.promoCreditStage).toBe(2)
    expect(w.promoCreditExpiresAt).toBe(expiry)
  })
})

describe('applyInitialSignupCredit', () => {
  test('low band: $2 now, stage 1', async () => {
    const result = scoreSignupRisk({ ...CLEAN, emailVerified: false })
    const out = await credit.applyInitialSignupCredit({ userId: 'u-1', result })
    expect(out.granted).toBe(true)
    expect(wallets.get('ws-1')!.promoCreditUsd).toBe(2)
    expect(wallets.get('ws-1')!.promoCreditStage).toBe(1)
  })

  test('medium band: nothing now, and the expiry clock does not start', async () => {
    const result = scoreSignupRisk({ ...CLEAN, emailVerified: false, ipLinkedAccounts: 1, burstSignups: 1 })
    expect(result.band).toBe('medium')
    const out = await credit.applyInitialSignupCredit({ userId: 'u-1', result })
    expect(out.granted).toBe(false)
    expect(wallets.get('ws-1')?.promoCreditStage ?? 0).toBe(0)
    expect(wallets.get('ws-1')?.promoCreditExpiresAt ?? null).toBeNull()
  })

  test('no_credit (disposable or high band): no wallet change', async () => {
    const result = scoreSignupRisk({ ...CLEAN, email: 'x@yopmail.com', emailVerified: false })
    expect(result.decision).toBe(CREDIT_DECISIONS.none)
    await credit.applyInitialSignupCredit({ userId: 'u-1', result })
    // No grant: the wallet is not created here (allocation is lazy elsewhere).
    expect(wallets.get('ws-1')?.promoCreditUsd ?? 0).toBe(0)
    expect(wallets.get('ws-1')?.promoCreditStage ?? 0).toBe(0)
  })
})

describe('releaseSignupCreditOnVerification', () => {
  test('releases the $8 once, then refuses to pay again', async () => {
    seedAssessment(CREDIT_DECISIONS.initial)
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1 })

    const first = await credit.releaseSignupCreditOnVerification({ userId: 'u-1' })
    expect(first.released).toBe(true)
    expect(first.amountUsd).toBe(8)
    expect(wallets.get('ws-1')!.promoCreditUsd).toBe(10)
    expect(assessments.get('u-1')!.decision).toBe(CREDIT_DECISIONS.released)

    const second = await credit.releaseSignupCreditOnVerification({ userId: 'u-1' })
    expect(second.released).toBe(false)
    expect(second.reason).toBe('not_eligible')
    expect(wallets.get('ws-1')!.promoCreditUsd).toBe(10)
  })

  test('held (medium) signups release the full $10, expiring 30 days after verification', async () => {
    seedAssessment(CREDIT_DECISIONS.held)
    const verifiedAt = new Date('2026-10-20T00:00:00Z')
    const out = await credit.releaseSignupCreditOnVerification({ userId: 'u-1', now: verifiedAt })
    expect(out.released).toBe(true)
    expect(out.amountUsd).toBe(10)
    const w = wallets.get('ws-1')!
    expect(w.promoCreditUsd).toBe(10)
    expect(w.promoCreditStage).toBe(2)
    expect(new Date(w.promoCreditExpiresAt).getTime()).toBe(verifiedAt.getTime() + 30 * DAY)
  })

  test('a re-score that turns high risk (burst since signup) blocks the release', async () => {
    seedAssessment(CREDIT_DECISIONS.initial)
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1 })
    riskState.features = { ...CLEAN, ipLinkedAccounts: 3, burstSignups: 1 }

    const out = await credit.releaseSignupCreditOnVerification({ userId: 'u-1' })
    expect(out.released).toBe(false)
    expect(out.reason).toBe('rescored_high_risk')
    expect(wallets.get('ws-1')!.promoCreditUsd).toBe(2)
    expect(recorded.at(-1)!.decision).toBe(CREDIT_DECISIONS.none)
  })

  test('no assessment row: nothing happens', async () => {
    const out = await credit.releaseSignupCreditOnVerification({ userId: 'u-1' })
    expect(out).toEqual({ released: false, reason: 'no_assessment' })
  })
})

describe('approve / revoke (admin)', () => {
  test('approve tops up to the full $10 and records the reviewer', async () => {
    seedAssessment(CREDIT_DECISIONS.none)
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1 })
    const out = await credit.approveSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    expect(out.granted).toBe(true)
    expect(wallets.get('ws-1')!.promoCreditUsd).toBe(10)
    expect(assessments.get('u-1')!.reviewDecision).toBe('approved')
    expect(assessments.get('u-1')!.reviewedByUserId).toBe('admin-1')
    // Settled: a later verification must not release more.
    expect(assessments.get('u-1')!.decision).toBe(CREDIT_DECISIONS.released)
  })

  test('approving twice grants once', async () => {
    seedAssessment(CREDIT_DECISIONS.held)
    await credit.approveSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    const again = await credit.approveSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    expect(again.granted).toBe(false)
    expect(wallets.get('ws-1')!.promoCreditUsd).toBe(10)
  })

  test('revoke zeroes the balance, takes it off the granted total, and writes an audit event', async () => {
    seedAssessment(CREDIT_DECISIONS.initial)
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1 })
    const out = await credit.revokeSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    expect(out.revokedUsd).toBe(2)
    const w = wallets.get('ws-1')!
    expect(w.promoCreditUsd).toBe(0)
    expect(w.promoCreditGrantedUsd).toBe(0)
    expect(assessments.get('u-1')!.reviewDecision).toBe('revoked')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({ actionType: 'signup_credit_revoked', billedUsd: 0, balanceBefore: 2 })
  })

  test('approve after a revoke restores the full $10', async () => {
    seedAssessment(CREDIT_DECISIONS.initial)
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 10, toStage: 2 })
    wallets.get('ws-1')!.promoCreditUsd = 6 // $4 already spent
    await credit.revokeSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    const out = await credit.approveSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    expect(out.grantedUsd).toBe(6)
    expect(wallets.get('ws-1')!.promoCreditUsd).toBe(6)
    expect(wallets.get('ws-1')!.promoCreditGrantedUsd).toBe(10)
  })

  test('approve gives expired credit a fresh expiry', async () => {
    seedAssessment(CREDIT_DECISIONS.none)
    const now = new Date('2026-12-01T00:00:00Z')
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1, now: new Date('2026-10-01T00:00:00Z') })
    await credit.approveSignupCredit({ userId: 'u-1', adminUserId: 'admin-1', now })
    expect(new Date(wallets.get('ws-1')!.promoCreditExpiresAt).getTime()).toBe(now.getTime() + 30 * DAY)
  })
})

describe('expireSignupCredits', () => {
  test('zeroes expired balances and writes a zero-cost audit event', async () => {
    const now = new Date('2026-11-01T00:00:00Z')
    const w = newWallet('ws-1')
    w.promoCreditUsd = 3
    w.promoCreditExpiresAt = new Date('2026-10-31T00:00:00Z')

    const n = await credit.expireSignupCredits(now)
    expect(n).toBe(1)
    expect(wallets.get('ws-1')!.promoCreditUsd).toBe(0)
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      actionType: 'signup_credit_expired',
      balanceBefore: 3,
      billedUsd: 0,
      source: 'promo',
      workspaceId: 'ws-1',
    })
  })

  test('leaves unexpired balances alone', async () => {
    const now = new Date('2026-10-15T00:00:00Z')
    const w = newWallet('ws-1')
    w.promoCreditUsd = 3
    w.promoCreditExpiresAt = new Date('2026-11-15T00:00:00Z')
    expect(await credit.expireSignupCredits(now)).toBe(0)
    expect(wallets.get('ws-1')!.promoCreditUsd).toBe(3)
    expect(usageEvents).toHaveLength(0)
  })

  test('only expires wallets owned by this region (home-region partition)', async () => {
    const now = new Date('2026-11-01T00:00:00Z')
    for (const ws of ['ws-home', 'ws-peer']) {
      const w = newWallet(ws)
      w.promoCreditUsd = 1
      w.promoCreditExpiresAt = new Date('2026-10-01T00:00:00Z')
    }
    homeFilter = new Set(['ws-home'])
    expect(await credit.expireSignupCredits(now)).toBe(1)
    expect(wallets.get('ws-home')!.promoCreditUsd).toBe(0)
    expect(wallets.get('ws-peer')!.promoCreditUsd).toBe(1)
  })
})
