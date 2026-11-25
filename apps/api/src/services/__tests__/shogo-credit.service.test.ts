// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

// ============================================================================
// In-memory grant table
//
// Deliberately a real (if tiny) implementation of the queries the service
// makes, not call-count stubs: the properties under test — FEFO order, never
// negative, never double-spent, idempotent grants — are properties of which
// rows the `where` clauses match, so a stub that returns whatever the test
// expects would prove nothing.
// ============================================================================

type GrantRow = {
  id: string
  workspaceId: string
  source: string
  sourceRef: string
  amountUsd: number
  remainingUsd: number
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

type OrderBy = Record<string, { sort?: 'asc' | 'desc'; nulls?: 'first' | 'last' } | 'asc' | 'desc'>

function compareForSort(a: any, b: any, dir: 'asc' | 'desc', nulls: 'first' | 'last'): number {
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  if (aNull || bNull) {
    // `nulls: 'last'` is the only mode the service asks for; keep it explicit.
    if (aNull && bNull) return 0
    return (aNull ? 1 : -1) * (nulls === 'last' ? 1 : -1)
  }
  const delta = a instanceof Date && b instanceof Date ? a.getTime() - b.getTime() : a < b ? -1 : a > b ? 1 : 0
  return dir === 'desc' ? -delta : delta
}

function matches(row: Record<string, any>, where: Record<string, any> | undefined): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === 'OR') {
      if (!(cond as Record<string, any>[]).some((clause) => matches(row, clause))) return false
      continue
    }
    const value = row[key]
    if (cond === null) {
      if (value !== null && value !== undefined) return false
      continue
    }
    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false
      continue
    }
    if (typeof cond === 'object') {
      const op = cond as Record<string, any>
      if ('gt' in op) {
        if (value === null || value === undefined || !(value > op.gt)) return false
        continue
      }
      if ('gte' in op) {
        if (value === null || value === undefined || !(value >= op.gte)) return false
        continue
      }
      if ('in' in op) {
        if (!(op.in as any[]).includes(value)) return false
        continue
      }
      throw new Error(`fake prisma: unsupported operator ${JSON.stringify(cond)} on ${key}`)
    }
    if (value !== cond) return false
  }
  return true
}

function sortRows<T extends Record<string, any>>(rows: T[], orderBy: OrderBy | OrderBy[] | undefined): T[] {
  const specs = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : []
  if (specs.length === 0) return rows
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [key, raw] of Object.entries(spec)) {
        const config = typeof raw === 'string' ? { sort: raw } : raw
        const delta = compareForSort(a[key], b[key], config.sort ?? 'asc', config.nulls ?? 'first')
        if (delta !== 0) return delta
      }
    }
    return 0
  })
}

function createGrantTable() {
  const rows: GrantRow[] = []
  let nextId = 1
  /**
   * Runs before each `updateMany` lands, so a test can interleave a competing
   * writer between the service's read and its write.
   */
  const hooks: { beforeUpdateMany?: () => void } = {}

  const table = {
    rows,
    hooks,
    seed(row: Partial<GrantRow> & { workspaceId: string; amountUsd: number }) {
      const created: GrantRow = {
        id: `grant-${nextId++}`,
        source: row.source ?? 'signup',
        sourceRef: row.sourceRef ?? `ref-${nextId}`,
        remainingUsd: row.amountUsd,
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
        ...row,
      }
      rows.push(created)
      return created
    },
    findFirst: async ({ where, orderBy }: any) => {
      const hit = sortRows(rows.filter((row) => matches(row, where)), orderBy)[0]
      return hit ? { ...hit } : null
    },
    findMany: async ({ where }: any) => rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    create: async ({ data }: any) => {
      if (rows.some((row) => row.source === data.source && row.sourceRef === data.sourceRef)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      }
      const created: GrantRow = { id: `grant-${nextId++}`, revokedAt: null, createdAt: new Date(), ...data }
      rows.push(created)
      return { ...created }
    },
    updateMany: async ({ where, data }: any) => {
      hooks.beforeUpdateMany?.()
      let count = 0
      for (const row of rows) {
        if (!matches(row, where)) continue
        if (data.remainingUsd?.decrement != null) row.remainingUsd -= data.remainingUsd.decrement
        if (data.remainingUsd != null && typeof data.remainingUsd === 'number') row.remainingUsd = data.remainingUsd
        if ('revokedAt' in data) row.revokedAt = data.revokedAt
        count++
      }
      return { count }
    },
    aggregate: async ({ _sum, where }: any) => {
      const matched = rows.filter((row) => matches(row, where))
      const out: Record<string, number | null> = {}
      for (const field of Object.keys(_sum ?? {})) {
        const sum = matched.reduce((total, row) => total + ((row as any)[field] ?? 0), 0)
        out[field] = matched.length > 0 ? sum : null
      }
      return { _sum: out }
    },
    count: async ({ where }: any) => rows.filter((row) => matches(row, where)).length,
  }
  return table
}

const grants = createGrantTable()

const workspaceRows = new Map<string, { id: string; kind: string }>()
const memberRows: {
  workspaceId: string
  userId: string
  role: string
  projectId: string | null
  workspaceKind: string
  parentWorkspaceId: string | null
  createdAt: Date
}[] = []

const prismaStub = {
  shogoCreditGrant: grants,
  workspace: {
    findUnique: async ({ where }: any) => {
      const row = workspaceRows.get(where.id)
      return row ? { ...row } : null
    },
  },
  member: {
    findFirst: async ({ where, orderBy }: any) => {
      const hit = sortRows(
        memberRows.filter((row) => matches(row, where)),
        orderBy,
      )[0]
      return hit ? { workspaceId: hit.workspaceId, userId: hit.userId } : null
    },
  },
}

// `matches` sees the flattened member row, so translate the nested
// `workspace: { kind, parentWorkspaceId }` filter into flat columns.
const originalFindFirst = prismaStub.member.findFirst
prismaStub.member.findFirst = async (args: any) => {
  const workspaceFilter = args?.where?.workspace
  if (!workspaceFilter) return originalFindFirst(args)
  const flatWhere = { ...args.where }
  delete flatWhere.workspace
  const hit = sortRows(
    memberRows.filter(
      (row) =>
        matches(row, flatWhere) &&
        (workspaceFilter.kind === undefined || row.workspaceKind === workspaceFilter.kind) &&
        (workspaceFilter.parentWorkspaceId === undefined ||
          row.parentWorkspaceId === workspaceFilter.parentWorkspaceId),
    ),
    args.orderBy,
  )[0]
  return hit ? { workspaceId: hit.workspaceId, userId: hit.userId } : null
}

mock.module('../../lib/prisma', () => withPrismaExports({ prisma: prismaStub as any }))

const {
  availableShogoCredit,
  clearShogoCreditSourceCache,
  grantShogoCredit,
  grantedShogoCreditUsd,
  isShogoCreditModel,
  resolveShogoCreditSource,
  revokeShogoCredit,
  soonestShogoCreditExpiry,
  spendShogoCredit,
} = await import('../shogo-credit.service')

// The service types its client as the real Prisma delegate; the fake above
// implements every method it calls.
const db = prismaStub as any

const NOW = new Date('2026-11-25T12:00:00.000Z')
const inDays = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000)

beforeEach(() => {
  grants.rows.length = 0
  grants.hooks.beforeUpdateMany = undefined
  workspaceRows.clear()
  memberRows.length = 0
  clearShogoCreditSourceCache()
})

describe('isShogoCreditModel', () => {
  it('accepts every spelling of a Hoshi public model id', () => {
    for (const id of ['hoshi-1.0', 'hoshi-1-0', 'hoshi-2.0', 'hoshi-2-0', 'HOSHI-1.0', '  hoshi-2.0  ']) {
      expect(isShogoCreditModel(id)).toBe(true)
    }
  })

  it('refuses everything else, including the backing model behind an alias', () => {
    for (const id of ['claude-opus-4-7', 'gpt-5.1', 'deepseek-v4', 'hoshi', '', '   ', null, undefined]) {
      expect(isShogoCreditModel(id as any)).toBe(false)
    }
  })
})

describe('grantShogoCredit', () => {
  it('creates one grant that is immediately spendable', async () => {
    const grant = await grantShogoCredit(
      { workspaceId: 'w1', amountUsd: 2, source: 'signup', sourceRef: 'signup:w1:stage1', expiresAt: inDays(30) },
      db,
    )
    expect(grant.amountUsd).toBe(2)
    expect(grant.remainingUsd).toBe(2)
    expect(await availableShogoCredit(db, 'w1', NOW)).toBe(2)
  })

  it('pays once for a retried idempotency key', async () => {
    const params = {
      workspaceId: 'w1',
      amountUsd: 2,
      source: 'signup' as const,
      sourceRef: 'signup:w1:stage1',
      expiresAt: inDays(30),
    }
    const first = await grantShogoCredit(params, db)
    const second = await grantShogoCredit(params, db)
    expect(second.id).toBe(first.id)
    expect(grants.rows).toHaveLength(1)
    expect(await availableShogoCredit(db, 'w1', NOW)).toBe(2)
  })

  it('treats the same ref under a different source as a separate grant', async () => {
    await grantShogoCredit(
      { workspaceId: 'w1', amountUsd: 2, source: 'signup', sourceRef: 'shared', expiresAt: null },
      db,
    )
    await grantShogoCredit(
      { workspaceId: 'w1', amountUsd: 5, source: 'admin', sourceRef: 'shared', expiresAt: null },
      db,
    )
    expect(await availableShogoCredit(db, 'w1', NOW)).toBe(7)
  })

  it('refuses a non-positive amount rather than writing a dead grant', async () => {
    await expect(
      grantShogoCredit({ workspaceId: 'w1', amountUsd: 0, source: 'admin', sourceRef: 'x', expiresAt: null }, db),
    ).rejects.toThrow(/positive/)
    expect(grants.rows).toHaveLength(0)
  })
})

describe('availableShogoCredit', () => {
  it('counts live grants only — expired, revoked and spent ones are invisible', async () => {
    grants.seed({ workspaceId: 'w1', amountUsd: 2, expiresAt: inDays(10) })
    grants.seed({ workspaceId: 'w1', amountUsd: 5, expiresAt: inDays(-1) })
    grants.seed({ workspaceId: 'w1', amountUsd: 3, revokedAt: NOW, remainingUsd: 0 })
    grants.seed({ workspaceId: 'w1', amountUsd: 4, remainingUsd: 0 })
    grants.seed({ workspaceId: 'w2', amountUsd: 9, expiresAt: null })
    expect(await availableShogoCredit(db, 'w1', NOW)).toBe(2)
  })

  it('returns the soonest live expiry, ignoring never-expiring grants and dead rows', async () => {
    grants.seed({ workspaceId: 'w1', amountUsd: 1, expiresAt: inDays(-1) })
    grants.seed({ workspaceId: 'w1', amountUsd: 1, expiresAt: inDays(20) })
    grants.seed({ workspaceId: 'w1', amountUsd: 1, expiresAt: inDays(5) })
    grants.seed({ workspaceId: 'w1', amountUsd: 1, expiresAt: null })
    const expiry = await soonestShogoCreditExpiry(db, 'w1', NOW)
    expect(expiry?.getTime()).toBe(inDays(5).getTime())
  })

  it('reports no expiry when only a never-expiring reward is left', async () => {
    grants.seed({ workspaceId: 'w1', amountUsd: 5, source: 'learn_reward', expiresAt: null })
    expect(await soonestShogoCreditExpiry(db, 'w1', NOW)).toBeNull()
  })
})

describe('spendShogoCredit', () => {
  it('spends the soonest-expiring grant first and leaves the rest untouched', async () => {
    const early = grants.seed({ workspaceId: 'w1', amountUsd: 2, expiresAt: inDays(5) })
    const late = grants.seed({ workspaceId: 'w1', amountUsd: 5, expiresAt: inDays(20) })

    const result = await spendShogoCredit(db, 'w1', 1.5, NOW)

    expect(result.spentUsd).toBeCloseTo(1.5, 10)
    expect(result.grantIds).toEqual([early.id])
    expect(early.remainingUsd).toBeCloseTo(0.5, 10)
    expect(late.remainingUsd).toBe(5)
  })

  it('spans grants when one cannot cover the call, never-expiring last', async () => {
    const early = grants.seed({ workspaceId: 'w1', amountUsd: 1, expiresAt: inDays(5) })
    const late = grants.seed({ workspaceId: 'w1', amountUsd: 2, expiresAt: inDays(20) })
    const forever = grants.seed({ workspaceId: 'w1', amountUsd: 10, source: 'learn_reward', expiresAt: null })

    const result = await spendShogoCredit(db, 'w1', 2.5, NOW)

    expect(result.spentUsd).toBeCloseTo(2.5, 10)
    expect(result.grantIds).toEqual([early.id, late.id])
    expect(early.remainingUsd).toBe(0)
    expect(late.remainingUsd).toBeCloseTo(0.5, 10)
    expect(forever.remainingUsd).toBe(10)
  })

  it('never goes below zero and reports what it actually covered', async () => {
    const only = grants.seed({ workspaceId: 'w1', amountUsd: 0.4, expiresAt: inDays(5) })

    const result = await spendShogoCredit(db, 'w1', 3, NOW)

    expect(result.spentUsd).toBeCloseTo(0.4, 10)
    expect(result.grantIds).toEqual([only.id])
    expect(only.remainingUsd).toBe(0)
    expect(await availableShogoCredit(db, 'w1', NOW)).toBe(0)
  })

  it('does not select an expired or revoked grant', async () => {
    const expired = grants.seed({ workspaceId: 'w1', amountUsd: 5, expiresAt: inDays(-1) })
    const revoked = grants.seed({ workspaceId: 'w1', amountUsd: 5, revokedAt: inDays(-2) })

    const result = await spendShogoCredit(db, 'w1', 1, NOW)

    expect(result).toEqual({ spentUsd: 0, grantIds: [] })
    expect(expired.remainingUsd).toBe(5)
    expect(revoked.remainingUsd).toBe(5)
  })

  // The debit is a conditional update: when a competing request takes the cents
  // between the read and the write, the update matches nothing and the service
  // re-reads instead of going negative. Two consumes in flight must therefore
  // never spend the same cent twice.
  it('cannot double-spend a grant when a concurrent debit lands first', async () => {
    const grant = grants.seed({ workspaceId: 'w1', amountUsd: 1, expiresAt: inDays(5) })
    let raced = false
    grants.hooks.beforeUpdateMany = () => {
      if (raced) return
      raced = true
      // The other request wins the race for the only grant's cents.
      grant.remainingUsd = 0
    }

    const result = await spendShogoCredit(db, 'w1', 1, NOW)

    expect(result.spentUsd).toBe(0)
    expect(result.grantIds).toEqual([])
    expect(grant.remainingUsd).toBe(0)
  })

  it('is a no-op for a zero amount', async () => {
    const grant = grants.seed({ workspaceId: 'w1', amountUsd: 1, expiresAt: inDays(5) })
    expect(await spendShogoCredit(db, 'w1', 0, NOW)).toEqual({ spentUsd: 0, grantIds: [] })
    expect(grant.remainingUsd).toBe(1)
  })
})

describe('revokeShogoCredit', () => {
  it('zeroes live grants from one source and leaves the others alone', async () => {
    const signup = grants.seed({ workspaceId: 'w1', amountUsd: 2, source: 'signup', expiresAt: inDays(10) })
    const reward = grants.seed({ workspaceId: 'w1', amountUsd: 3, source: 'learn_reward', expiresAt: null })

    const revoked = await revokeShogoCredit({ workspaceId: 'w1', source: 'signup', now: NOW }, db)

    expect(revoked).toBe(2)
    expect(signup.remainingUsd).toBe(0)
    expect(signup.revokedAt?.getTime()).toBe(NOW.getTime())
    expect(reward.remainingUsd).toBe(3)
    expect(await availableShogoCredit(db, 'w1', NOW)).toBe(3)
  })

  it('reports only the balance it actually clawed back, so a second revoke is a no-op', async () => {
    grants.seed({ workspaceId: 'w1', amountUsd: 2, source: 'signup', expiresAt: inDays(10) })
    expect(await revokeShogoCredit({ workspaceId: 'w1', source: 'signup', now: NOW }, db)).toBe(2)
    expect(await revokeShogoCredit({ workspaceId: 'w1', source: 'signup', now: NOW }, db)).toBe(0)
  })

  it('claws back what is left after spending, not the original amount', async () => {
    grants.seed({ workspaceId: 'w1', amountUsd: 2, source: 'signup', expiresAt: inDays(10) })
    await spendShogoCredit(db, 'w1', 1.25, NOW)
    expect(await revokeShogoCredit({ workspaceId: 'w1', source: 'signup', now: NOW }, db)).toBeCloseTo(0.75, 10)
  })
})

describe('grantedShogoCreditUsd', () => {
  it('sums a source net of revokes, so a re-approval does not pay twice', async () => {
    grants.seed({ workspaceId: 'w1', amountUsd: 2, source: 'signup' })
    expect(await grantedShogoCreditUsd(db, 'w1', 'signup')).toBe(2)

    await revokeShogoCredit({ workspaceId: 'w1', source: 'signup', now: NOW }, db)
    expect(await grantedShogoCreditUsd(db, 'w1', 'signup')).toBe(0)
  })

  it('does not count another source or another workspace', async () => {
    grants.seed({ workspaceId: 'w1', amountUsd: 2, source: 'signup' })
    grants.seed({ workspaceId: 'w1', amountUsd: 7, source: 'learn_reward' })
    grants.seed({ workspaceId: 'w2', amountUsd: 9, source: 'signup' })
    expect(await grantedShogoCreditUsd(db, 'w1', 'signup')).toBe(2)
  })
})

describe('resolveShogoCreditSource', () => {
  it('uses the billed workspace\u2019s own credit without any lookup', async () => {
    const source = await resolveShogoCreditSource(db, 'w1', 3, NOW)
    expect(source).toEqual({ workspaceId: 'w1', availableUsd: 3 })
    expect(workspaceRows.size).toBe(0)
  })

  it('falls back to the owner\u2019s team workspace for a personal workspace', async () => {
    workspaceRows.set('personal-1', { id: 'personal-1', kind: 'personal' })
    memberRows.push({
      workspaceId: 'personal-1',
      userId: 'u1',
      role: 'owner',
      projectId: null,
      workspaceKind: 'personal',
      parentWorkspaceId: null,
      createdAt: NOW,
    })
    memberRows.push({
      workspaceId: 'team-1',
      userId: 'u1',
      role: 'owner',
      projectId: null,
      workspaceKind: 'team',
      parentWorkspaceId: null,
      createdAt: NOW,
    })
    grants.seed({ workspaceId: 'team-1', amountUsd: 4, expiresAt: inDays(20) })

    const source = await resolveShogoCreditSource(db, 'personal-1', 0, NOW)
    expect(source).toEqual({ workspaceId: 'team-1', availableUsd: 4 })
  })

  it('returns null when nothing live exists anywhere', async () => {
    workspaceRows.set('personal-1', { id: 'personal-1', kind: 'personal' })
    memberRows.push({
      workspaceId: 'personal-1',
      userId: 'u1',
      role: 'owner',
      projectId: null,
      workspaceKind: 'personal',
      parentWorkspaceId: null,
      createdAt: NOW,
    })
    expect(await resolveShogoCreditSource(db, 'personal-1', 0, NOW)).toBeNull()
  })

  it('memoises the resolution but re-reads the balance on every call', async () => {
    workspaceRows.set('personal-1', { id: 'personal-1', kind: 'personal' })
    memberRows.push({
      workspaceId: 'personal-1',
      userId: 'u1',
      role: 'owner',
      projectId: null,
      workspaceKind: 'personal',
      parentWorkspaceId: null,
      createdAt: NOW,
    })
    memberRows.push({
      workspaceId: 'team-1',
      userId: 'u1',
      role: 'owner',
      projectId: null,
      workspaceKind: 'team',
      parentWorkspaceId: null,
      createdAt: NOW,
    })
    const grant = grants.seed({ workspaceId: 'team-1', amountUsd: 4, expiresAt: inDays(20) })

    expect(await resolveShogoCreditSource(db, 'personal-1', 0, NOW)).toEqual({
      workspaceId: 'team-1',
      availableUsd: 4,
    })

    grant.remainingUsd = 1
    expect(await resolveShogoCreditSource(db, 'personal-1', 0, NOW)).toEqual({
      workspaceId: 'team-1',
      availableUsd: 1,
    })
  })
})
