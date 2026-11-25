// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Signup Shogo credit: staged grants are idempotent, verification releases
 * exactly once, high-risk rescoring blocks release, and expiry settles the
 * grants with an audit event. Prisma is an in-memory double that understands
 * the operators the service uses (equality, gt/gte/lt/lte, in, increment,
 * decrement).
 *
 * The money lives in `shogoCreditGrant` rows now (SHO-572) — the real
 * `shogo-credit.service` runs against this double, so a duplicate `sourceRef`
 * hits the same unique-key path production does. `usage_wallets` keeps only the
 * stage marker and the expiry anchor.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type Row = Record<string, any>
const DAY = 24 * 60 * 60 * 1000

const wallets = new Map<string, Row>()
const members: Row[] = []
const assessments = new Map<string, Row>()
const users = new Map<string, Row>()
const usageEvents: Row[] = []
const grants: Row[] = []
let grantSeq = 1
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

function grantRows(where: Row): Row[] {
  return grants.filter((g) => matches(g, where))
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
  shogoCreditGrant: {
    create: async ({ data }: { data: Row }) => {
      if (grants.some((g) => g.source === data.source && g.sourceRef === data.sourceRef)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      }
      const row: Row = {
        id: `grant-${grantSeq++}`,
        remainingUsd: data.amountUsd,
        revokedAt: null,
        expiresAt: null,
        createdAt: new Date(),
        ...data,
      }
      grants.push(row)
      return { ...row }
    },
    findFirst: async ({ where }: { where: Row }) => {
      const row = grantRows(where)[0]
      return row ? { ...row } : null
    },
    findMany: async ({ where }: { where: Row }) => grantRows(where).map((g) => ({ ...g })),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = grantRows(where)
      rows.forEach((g) => applyData(g, data))
      return { count: rows.length }
    },
    count: async ({ where }: { where: Row }) => grantRows(where).length,
    aggregate: async ({ _sum, where }: { _sum: Row; where?: Row }) => {
      const rows = where ? grantRows(where) : grants
      const sums: Row = {}
      for (const field of Object.keys(_sum)) {
        sums[field] = rows.reduce((total, g) => total + (g[field] ?? 0), 0)
      }
      return { _sum: sums }
    },
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
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const w = wallets.get(where.workspaceId)
      if (!w) throw new Error(`wallet ${where.workspaceId} not found`)
      applyData(w, data)
      return { ...w }
    },
  },
  signupRiskAssessment: {
    // SHO-459: banned-linked count resolves linked ids first.
    findMany: async () => [],
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
    if (a) {
      a.decision = params.decision ?? params.result.decision
      // The real writer stores the new band/score; the trust hold reads them.
      a.band = params.result.band
      a.score = params.result.score
    }
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
  grants.length = 0
  grantSeq = 1
  recorded.length = 0
  homeFilter = null
  riskState.features = { ...CLEAN }
  members.push({ id: 'm-1', userId: 'u-1', workspaceId: 'ws-1', role: 'owner', projectId: null, createdAt: new Date(0) })
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

function signupGrants(workspaceId = 'ws-1'): Row[] {
  return grants.filter((g) => g.workspaceId === workspaceId && g.source === 'signup')
}

/** Spendable `signup` credit: live rows only, exactly what the API reports. */
function signupBalance(workspaceId = 'ws-1'): number {
  return signupGrants(workspaceId)
    .filter((g) => g.revokedAt === null)
    .reduce((sum, g) => sum + Math.max(0, g.remainingUsd), 0)
}

function seedGrant(overrides: Row = {}): Row {
  const row: Row = {
    id: `grant-${grantSeq++}`,
    workspaceId: 'ws-1',
    source: 'signup',
    sourceRef: `seed-${grantSeq}`,
    amountUsd: 1,
    remainingUsd: 1,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date(),
    ...overrides,
  }
  grants.push(row)
  return row
}

function fakeSpend(workspaceId: string, amountUsd: number): void {
  let remaining = amountUsd
  for (const g of signupGrants(workspaceId)) {
    if (remaining <= 0) break
    const take = Math.min(remaining, g.remainingUsd)
    g.remainingUsd -= take
    remaining -= take
  }
  if (remaining > 1e-9) throw new Error('fakeSpend: not enough credit')
}

describe('grantPromoCredit (staged, idempotent)', () => {
  test('first stage grant creates one grant and anchors the expiry to now + 30 days', async () => {
    const now = new Date('2026-10-01T00:00:00Z')
    const changed = await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1, now })
    expect(changed).toBe(true)
    const w = wallets.get('ws-1')!
    // The wallet is the stage marker and expiry anchor now; the money is a grant.
    expect(w.promoCreditUsd).toBe(0)
    expect(w.promoCreditStage).toBe(1)
    expect(new Date(w.promoCreditExpiresAt).getTime()).toBe(now.getTime() + 30 * DAY)
    expect(signupGrants()).toHaveLength(1)
    expect(signupBalance()).toBe(2)
    expect(signupGrants()[0].expiresAt.getTime()).toBe(now.getTime() + 30 * DAY)
  })

  test('repeating the same stage grants nothing (retry-safe)', async () => {
    const now = new Date('2026-10-01T00:00:00Z')
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1, now })
    const again = await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1, now })
    expect(again).toBe(false)
    expect(signupBalance()).toBe(2)
    expect(signupGrants()).toHaveLength(1)
  })

  test('the verification stage adds the rest without moving the expiry', async () => {
    const t0 = new Date('2026-10-01T00:00:00Z')
    const t1 = new Date('2026-10-05T00:00:00Z')
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1, now: t0 })
    const expiry = wallets.get('ws-1')!.promoCreditExpiresAt
    const changed = await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 8, toStage: 2, now: t1 })
    expect(changed).toBe(true)
    const w = wallets.get('ws-1')!
    expect(signupBalance()).toBe(10)
    expect(signupGrants()).toHaveLength(2)
    // Both stages share the anchor: verification must not extend the clock.
    for (const grant of signupGrants()) {
      expect(grant.expiresAt.getTime()).toBe(new Date(expiry).getTime())
    }
    expect(w.promoCreditStage).toBe(2)
    expect(w.promoCreditExpiresAt).toBe(expiry)
  })
})

describe('applyInitialSignupCredit', () => {
  test('low band: $2 now, stage 1', async () => {
    const result = scoreSignupRisk({ ...CLEAN, emailVerified: false })
    const out = await credit.applyInitialSignupCredit({ userId: 'u-1', result })
    expect(out.granted).toBe(true)
    expect(signupBalance()).toBe(2)
    expect(signupGrants()).toHaveLength(1)
    expect(wallets.get('ws-1')!.promoCreditStage).toBe(1)
  })

  test('medium band: nothing now, and the expiry clock does not start', async () => {
    const result = scoreSignupRisk({ ...CLEAN, emailVerified: false, ipLinkedAccounts: 1, burstSignups: 1 })
    expect(result.band).toBe('medium')
    const out = await credit.applyInitialSignupCredit({ userId: 'u-1', result })
    expect(out.granted).toBe(false)
    expect(wallets.get('ws-1')?.promoCreditStage ?? 0).toBe(0)
    expect(wallets.get('ws-1')?.promoCreditExpiresAt ?? null).toBeNull()
    expect(grants).toHaveLength(0)
  })

  test('no_credit (disposable or high band): no wallet change', async () => {
    const result = scoreSignupRisk({ ...CLEAN, email: 'x@yopmail.com', emailVerified: false })
    expect(result.decision).toBe(CREDIT_DECISIONS.none)
    await credit.applyInitialSignupCredit({ userId: 'u-1', result })
    // No grant: the wallet is not created here (allocation is lazy elsewhere).
    expect(grants).toHaveLength(0)
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
    expect(signupBalance()).toBe(10)
    expect(signupGrants()).toHaveLength(2)
    expect(assessments.get('u-1')!.decision).toBe(CREDIT_DECISIONS.released)

    const second = await credit.releaseSignupCreditOnVerification({ userId: 'u-1' })
    expect(second.released).toBe(false)
    expect(second.reason).toBe('not_eligible')
    expect(signupBalance()).toBe(10)
    expect(signupGrants()).toHaveLength(2)
  })

  test('held (medium) signups release the full $10, expiring 30 days after verification', async () => {
    seedAssessment(CREDIT_DECISIONS.held)
    const verifiedAt = new Date('2026-10-20T00:00:00Z')
    const out = await credit.releaseSignupCreditOnVerification({ userId: 'u-1', now: verifiedAt })
    expect(out.released).toBe(true)
    expect(out.amountUsd).toBe(10)
    const w = wallets.get('ws-1')!
    expect(signupBalance()).toBe(10)
    expect(signupGrants()).toHaveLength(1)
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
    expect(signupBalance()).toBe(2)
    expect(signupGrants()).toHaveLength(1)
    expect(recorded.at(-1)!.decision).toBe(CREDIT_DECISIONS.none)
  })

  test('no assessment row: nothing happens', async () => {
    const out = await credit.releaseSignupCreditOnVerification({ userId: 'u-1' })
    expect(out).toEqual({ released: false, reason: 'no_assessment' })
  })

  // ─── SHO-416: a high-band account is re-scored on verification ───────────
  // It was never credit-eligible (`no_credit`), so the re-score exists only to
  // lift — or confirm — the trust hold. Credit must not move either way.

  function seedHighBand() {
    const high = scoreSignupRisk({ ...CLEAN, ipLinkedAccounts: 3, burstSignups: 1, emailVerified: false })
    expect(high.band).toBe('high')
    assessments.set('u-1', {
      userId: 'u-1',
      decision: CREDIT_DECISIONS.none,
      band: 'high',
      score: high.score,
      signals: { provider: 'credential', allowlisted: false },
      ip: '203.0.113.9',
      ipPrefix: null,
      deviceId: null,
      emailCanonical: 'alice@company.io',
      country: 'US',
    })
  }

  test('a high-band account that re-scores below high lifts the hold and grants no credit', async () => {
    seedHighBand()
    riskState.features = { ...CLEAN }

    const out = await credit.releaseSignupCreditOnVerification({ userId: 'u-1' })
    expect(out.released).toBe(false)
    expect(out.reason).toBe('rescored_below_high')
    expect(out.band).not.toBe('high')
    // The band is recorded, so the trust hold now resolves to null.
    expect(assessments.get('u-1')!.band).not.toBe('high')
    // Credit rules are unchanged: still `no_credit`, no wallet write.
    expect(assessments.get('u-1')!.decision).toBe(CREDIT_DECISIONS.none)
    expect(grants).toHaveLength(0)
  })

  test('a high-band account that stays high keeps the hold and grants no credit', async () => {
    seedHighBand()
    riskState.features = { ...CLEAN, ipLinkedAccounts: 3, burstSignups: 1 }

    const out = await credit.releaseSignupCreditOnVerification({ userId: 'u-1' })
    expect(out.released).toBe(false)
    expect(out.reason).toBe('rescored_high_risk')
    expect(assessments.get('u-1')!.band).toBe('high')
    expect(assessments.get('u-1')!.decision).toBe(CREDIT_DECISIONS.none)
    expect(grants).toHaveLength(0)
  })
})

describe('approve / revoke (admin)', () => {
  test('approve tops up to the full $10 and records the reviewer', async () => {
    seedAssessment(CREDIT_DECISIONS.none)
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1 })
    const out = await credit.approveSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    expect(out.granted).toBe(true)
    expect(out.grantedUsd).toBe(8)
    expect(signupBalance()).toBe(10)
    expect(assessments.get('u-1')!.reviewDecision).toBe('approved')
    expect(assessments.get('u-1')!.reviewedByUserId).toBe('admin-1')
    // Settled: a later verification must not release more.
    expect(assessments.get('u-1')!.decision).toBe(CREDIT_DECISIONS.released)
  })

  test('approving twice grants once', async () => {
    seedAssessment(CREDIT_DECISIONS.held)
    const first = await credit.approveSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    expect(first.grantedUsd).toBe(10)
    const again = await credit.approveSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    expect(again.granted).toBe(false)
    expect(again.grantedUsd).toBe(0)
    expect(signupBalance()).toBe(10)
    expect(signupGrants()).toHaveLength(1)
  })

  test('revoke zeroes the balance, takes it off the granted total, and writes an audit event', async () => {
    seedAssessment(CREDIT_DECISIONS.initial)
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1 })
    const out = await credit.revokeSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    expect(out.revokedUsd).toBe(2)
    expect(signupBalance()).toBe(0)
    const grant = signupGrants()[0]
    expect(grant.remainingUsd).toBe(0)
    expect(grant.revokedAt).toBeInstanceOf(Date)
    expect(assessments.get('u-1')!.reviewDecision).toBe('revoked')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      actionType: 'signup_credit_revoked',
      billedUsd: 0,
      balanceBefore: 2,
      balanceAfter: 0,
      source: 'promo',
      workspaceId: 'ws-1',
      memberId: 'm-1',
    })
  })

  test('revoking a workspace with no live credit is a no-op and writes nothing', async () => {
    seedAssessment(CREDIT_DECISIONS.initial)
    const out = await credit.revokeSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    expect(out.revokedUsd).toBe(0)
    expect(usageEvents).toHaveLength(0)
  })

  // A revoke is a forfeit: it zeroes both the balance and the granted total, so
  // a later approval re-grants the full amount rather than the remainder. The
  // audit trail keeps the revoke, so the extra $4 spent before it is visible.
  test('approve after a revoke grants the full credit again', async () => {
    seedAssessment(CREDIT_DECISIONS.initial)
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 10, toStage: 2 })
    fakeSpend('ws-1', 4)
    await credit.revokeSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    const out = await credit.approveSignupCredit({ userId: 'u-1', adminUserId: 'admin-1' })
    expect(out.grantedUsd).toBe(10)
    expect(signupBalance()).toBe(10)
  })

  test('approve gives expired credit a fresh expiry', async () => {
    seedAssessment(CREDIT_DECISIONS.none)
    const now = new Date('2026-12-01T00:00:00Z')
    await credit.grantPromoCredit({ workspaceId: 'ws-1', amountUsd: 2, toStage: 1, now: new Date('2026-10-01T00:00:00Z') })
    await credit.approveSignupCredit({ userId: 'u-1', adminUserId: 'admin-1', now })
    const topUp = signupGrants().at(-1)!
    expect(topUp.remainingUsd).toBe(8)
    expect(topUp.expiresAt.getTime()).toBe(now.getTime() + 30 * DAY)
    expect(new Date(wallets.get('ws-1')!.promoCreditExpiresAt).getTime()).toBe(now.getTime() + 30 * DAY)
    expect(signupBalance()).toBe(10)
  })
})

describe('expireSignupCredits', () => {
  test('settles expired signup grants and writes one zero-cost audit event', async () => {
    const now = new Date('2026-11-01T00:00:00Z')
    newWallet('ws-1')
    const grant = seedGrant({ amountUsd: 3, remainingUsd: 3, expiresAt: new Date('2026-10-31T00:00:00Z') })

    expect(await credit.expireSignupCredits(now)).toBe(1)
    expect(grant.remainingUsd).toBe(0)
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      actionType: 'signup_credit_expired',
      balanceBefore: 3,
      balanceAfter: 0,
      billedUsd: 0,
      source: 'promo',
      workspaceId: 'ws-1',
    })
  })

  test('records only what was left unspent', async () => {
    const now = new Date('2026-11-01T00:00:00Z')
    newWallet('ws-1')
    seedGrant({ amountUsd: 3, remainingUsd: 0.75, expiresAt: new Date('2026-10-31T00:00:00Z') })

    expect(await credit.expireSignupCredits(now)).toBe(1)
    expect(usageEvents[0]).toMatchObject({ balanceBefore: 0.75 })
    expect(signupBalance()).toBe(0)
  })

  test('leaves unexpired grants alone', async () => {
    const now = new Date('2026-10-15T00:00:00Z')
    newWallet('ws-1')
    const grant = seedGrant({ amountUsd: 3, remainingUsd: 3, expiresAt: new Date('2026-11-15T00:00:00Z') })

    expect(await credit.expireSignupCredits(now)).toBe(0)
    expect(grant.remainingUsd).toBe(3)
    expect(usageEvents).toHaveLength(0)
  })

  test('ignores other sources and grants with nothing left', async () => {
    const now = new Date('2026-11-01T00:00:00Z')
    newWallet('ws-1')
    const admin = seedGrant({ source: 'admin', amountUsd: 5, remainingUsd: 5, expiresAt: new Date('2026-10-01T00:00:00Z') })
    const spent = seedGrant({ amountUsd: 2, remainingUsd: 0, expiresAt: new Date('2026-10-01T00:00:00Z') })

    expect(await credit.expireSignupCredits(now)).toBe(0)
    expect(admin.remainingUsd).toBe(5)
    expect(spent.remainingUsd).toBe(0)
    expect(usageEvents).toHaveLength(0)
  })

  test('only expires workspaces owned by this region (home-region partition)', async () => {
    const now = new Date('2026-11-01T00:00:00Z')
    const home = seedGrant({ workspaceId: 'ws-home', amountUsd: 1, remainingUsd: 1, expiresAt: new Date('2026-10-01T00:00:00Z') })
    const peer = seedGrant({ workspaceId: 'ws-peer', amountUsd: 1, remainingUsd: 1, expiresAt: new Date('2026-10-01T00:00:00Z') })
    newWallet('ws-home')
    newWallet('ws-peer')
    members.push({ id: 'm-home', userId: 'u-home', workspaceId: 'ws-home', role: 'owner', projectId: null, createdAt: new Date(0) })

    homeFilter = new Set(['ws-home'])
    expect(await credit.expireSignupCredits(now)).toBe(1)
    expect(home.remainingUsd).toBe(0)
    expect(peer.remainingUsd).toBe(1)
  })
})
