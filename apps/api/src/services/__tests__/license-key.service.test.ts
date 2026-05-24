// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for src/services/license-key.service.ts.
//
// Strategy: stand up an in-memory prisma mock that emulates exactly the
// query surface the service uses (licenseKey + workspaceGrant +
// $transaction). The service is intentionally narrow so this mock stays
// small. The mock enforces the same uniqueness invariants the real DB
// does (codeHash, redeemedByWorkspaceId, redeemedGrantId) so a
// regression that double-redeems via a non-atomic code path would fail
// here too.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

interface LicenseKeyRow {
  id: string
  codeHash: string
  codePrefix: string
  batchId: string | null
  planId: string
  monthlyIncludedUsd: number
  freeSeats: number
  durationDays: number | null
  expiresAt: Date | null
  redeemedAt: Date | null
  redeemedByWorkspaceId: string | null
  redeemedByUserId: string | null
  redeemedGrantId: string | null
  note: string | null
  createdByUserId: string | null
  createdAt: Date
}
interface GrantRow {
  id: string
  workspaceId: string
  freeSeats: number
  monthlyIncludedUsd: number
  planId: string | null
  startsAt: Date
  expiresAt: Date | null
  note: string | null
  createdByUserId: string | null
  createdAt: Date
}

const keys: LicenseKeyRow[] = []
const grants: GrantRow[] = []
let keyIdSeq = 0
let grantIdSeq = 0

function matchWhere(row: LicenseKeyRow, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR' && Array.isArray(v)) {
      const ok = v.some((clause) => matchWhere(row, clause as Record<string, unknown>))
      if (!ok) return false
      continue
    }
    if (k === 'redeemedAt') {
      const filter = v as null | { not: null } | { gt: Date }
      if (filter === null) {
        if (row.redeemedAt !== null) return false
      } else if (filter && typeof filter === 'object' && 'not' in filter) {
        if (row.redeemedAt === null) return false
      }
      continue
    }
    if (k === 'expiresAt') {
      if (v === null) {
        if (row.expiresAt !== null) return false
      } else if (v && typeof v === 'object' && 'gt' in (v as object)) {
        if (!row.expiresAt) return false
        if (+row.expiresAt <= +((v as { gt: Date }).gt)) return false
      }
      continue
    }
    if ((row as any)[k] !== v) return false
  }
  return true
}

const prismaMock = {
  licenseKey: {
    findUnique: async ({ where }: { where: { id?: string; codeHash?: string } }) => {
      if (where.codeHash) return keys.find((k) => k.codeHash === where.codeHash) ?? null
      if (where.id) return keys.find((k) => k.id === where.id) ?? null
      return null
    },
    findMany: async ({ where, take, skip, orderBy }: any) => {
      let rows = [...keys]
      if (where) {
        if (where.batchId) rows = rows.filter((k) => k.batchId === where.batchId)
        if (where.redeemedAt === null) rows = rows.filter((k) => k.redeemedAt === null)
        if (where.redeemedAt && typeof where.redeemedAt === 'object' && 'not' in where.redeemedAt) {
          rows = rows.filter((k) => k.redeemedAt !== null)
        }
      }
      if (orderBy?.createdAt === 'desc') rows.sort((a, b) => +b.createdAt - +a.createdAt)
      return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length))
    },
    create: async ({ data, select }: { data: any; select?: any }) => {
      if (keys.some((k) => k.codeHash === data.codeHash)) {
        throw new Error('unique constraint failed: codeHash')
      }
      keyIdSeq += 1
      const row: LicenseKeyRow = {
        id: `lk_${keyIdSeq}`,
        codeHash: data.codeHash,
        codePrefix: data.codePrefix,
        batchId: data.batchId ?? null,
        planId: data.planId,
        monthlyIncludedUsd: data.monthlyIncludedUsd ?? 0,
        freeSeats: data.freeSeats ?? 0,
        durationDays: data.durationDays ?? null,
        expiresAt: data.expiresAt ?? null,
        redeemedAt: null,
        redeemedByWorkspaceId: null,
        redeemedByUserId: null,
        redeemedGrantId: null,
        note: data.note ?? null,
        createdByUserId: data.createdByUserId ?? null,
        createdAt: new Date(),
      }
      keys.push(row)
      if (!select) return row
      const out: any = {}
      for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k]
      out.id = row.id
      return out
    },
    update: async ({ where, data }: { where: { id?: string; codeHash?: string }; data: any }) => {
      const row = where.codeHash
        ? keys.find((k) => k.codeHash === where.codeHash)
        : where.id
        ? keys.find((k) => k.id === where.id)
        : undefined
      if (!row) throw new Error('licenseKey.update: not found')
      if (data.redeemedGrantId && data.redeemedGrantId !== row.redeemedGrantId) {
        if (keys.some((k) => k !== row && k.redeemedGrantId === data.redeemedGrantId)) {
          throw new Error('unique constraint failed: redeemedGrantId')
        }
      }
      if (data.redeemedByWorkspaceId && data.redeemedByWorkspaceId !== row.redeemedByWorkspaceId) {
        if (keys.some((k) => k !== row && k.redeemedByWorkspaceId === data.redeemedByWorkspaceId)) {
          throw new Error('unique constraint failed: redeemedByWorkspaceId')
        }
      }
      Object.assign(row, data)
      return row
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: any }) => {
      let count = 0
      for (const row of keys) {
        if (!matchWhere(row, where)) continue
        if (data.redeemedByWorkspaceId && data.redeemedByWorkspaceId !== row.redeemedByWorkspaceId) {
          if (keys.some((k) => k !== row && k.redeemedByWorkspaceId === data.redeemedByWorkspaceId)) {
            throw new Error('unique constraint failed: redeemedByWorkspaceId')
          }
        }
        Object.assign(row, data)
        count += 1
      }
      return { count }
    },
  },
  workspaceGrant: {
    create: async ({ data, select }: { data: any; select?: any }) => {
      grantIdSeq += 1
      const row: GrantRow = {
        id: `wg_${grantIdSeq}`,
        workspaceId: data.workspaceId,
        freeSeats: data.freeSeats ?? 0,
        monthlyIncludedUsd: data.monthlyIncludedUsd ?? 0,
        planId: data.planId ?? null,
        startsAt: data.startsAt ?? new Date(),
        expiresAt: data.expiresAt ?? null,
        note: data.note ?? null,
        createdByUserId: data.createdByUserId ?? null,
        createdAt: new Date(),
      }
      grants.push(row)
      if (!select) return row
      const out: any = {}
      for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k]
      return out
    },
  },
  // The service uses $transaction with an ARRAY of pre-built promises
  // (Prisma's "sequential transaction" form). Our mock returns the
  // resolved values in order.
  $transaction: async (ops: any) => {
    if (Array.isArray(ops)) return Promise.all(ops)
    return ops(prismaMock)
  },
}

mock.module('../../lib/prisma', () => ({ prisma: prismaMock }))

const {
  mintLicenseKeys,
  redeemLicenseKey,
  LicenseKeyRedeemError,
  hashCode,
  canonicalize,
  mintCode,
  listLicenseKeys,
  revokeLicenseKey,
} = await import('../license-key.service')

beforeEach(() => {
  keys.length = 0
  grants.length = 0
  keyIdSeq = 0
  grantIdSeq = 0
})

// ============================================================================
// Code format helpers
// ============================================================================

describe('canonicalize', () => {
  it('uppercases and trims', () => {
    expect(canonicalize('  shgo-pro-abcd-efgh-ijkl  ')).toBe('SHGO-PRO-ABCD-EFGH-IJKL')
  })
  it('preserves internal dashes', () => {
    expect(canonicalize('shgo-pro-1-2-3')).toBe('SHGO-PRO-1-2-3')
  })
})

describe('hashCode', () => {
  it('is stable across whitespace and case variants', () => {
    const a = hashCode('SHGO-PRO-ABCD-EFGH-IJKL')
    const b = hashCode('  shgo-pro-abcd-efgh-ijkl\n')
    expect(a).toBe(b)
  })
  it('differs across distinct plaintexts', () => {
    expect(hashCode('SHGO-PRO-AAAA-BBBB-CCCC')).not.toBe(hashCode('SHGO-PRO-AAAA-BBBB-CCCD'))
  })
  it('returns 64-char hex (sha-256)', () => {
    expect(hashCode('x')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('mintCode', () => {
  it('uses the configured prefix and grouped 4-char suffix', () => {
    const { plaintext } = mintCode('SHGO-PRO')
    expect(plaintext.startsWith('SHGO-PRO-')).toBe(true)
    const groups = plaintext.split('-')
    expect(groups.length).toBe(5) // SHGO, PRO, XXXX, XXXX, XXXX
    expect(groups.slice(2).every((g) => g.length === 4)).toBe(true)
  })
  it('uses an unambiguous alphabet (no 0/1/I/L/O)', () => {
    for (let i = 0; i < 50; i++) {
      const { plaintext } = mintCode('SHGO-PRO')
      const suffix = plaintext.split('-').slice(2).join('')
      expect(suffix).toMatch(/^[A-HJKMNPQRSTUVWXYZ2-9]+$/)
    }
  })
  it('canonical matches the plaintext exactly (already uppercased)', () => {
    const { plaintext, canonical } = mintCode('SHGO-PRO')
    expect(canonical).toBe(plaintext)
  })
})

// ============================================================================
// mintLicenseKeys
// ============================================================================

describe('mintLicenseKeys', () => {
  it('rejects count < 1', async () => {
    await expect(mintLicenseKeys({ count: 0, planId: 'pro' })).rejects.toThrow(/count/)
  })
  it('rejects count > 10000', async () => {
    await expect(mintLicenseKeys({ count: 10_001, planId: 'pro' })).rejects.toThrow(/10000/)
  })
  it('rejects free / unknown plan ids', async () => {
    await expect(mintLicenseKeys({ count: 1, planId: 'free' })).rejects.toThrow(/paid tier/)
    await expect(mintLicenseKeys({ count: 1, planId: 'banana' })).rejects.toThrow(/paid tier/)
  })
  it('accepts decorated plan ids and normalizes them (pro_200 -> pro)', async () => {
    const minted = await mintLicenseKeys({ count: 1, planId: 'pro_200' })
    expect(minted[0].planId).toBe('pro')
  })
  it('returns plaintext codes ONCE and only stores hashes', async () => {
    const minted = await mintLicenseKeys({ count: 3, planId: 'pro' })
    expect(minted).toHaveLength(3)
    for (const k of minted) {
      expect(k.plaintext).toMatch(/^SHGO-PRO-/)
      expect(k.codePrefix.length).toBe(12)
    }
    // All plaintexts distinct.
    expect(new Set(minted.map((k) => k.plaintext)).size).toBe(3)
    // Stored row has codeHash but no plaintext column.
    for (const k of keys) {
      expect(k.codeHash).toMatch(/^[0-9a-f]{64}$/)
      expect((k as any).plaintext).toBeUndefined()
    }
  })
  it('persists batchId, durationDays, monthlyIncludedUsd, freeSeats, note', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00Z')
    await mintLicenseKeys({
      count: 2,
      planId: 'pro',
      batchId: 'hn-launch',
      durationDays: 30,
      monthlyIncludedUsd: 50,
      freeSeats: 2,
      expiresAt,
      note: 'HN launch giveaway',
      createdByUserId: 'admin-1',
    })
    for (const row of keys) {
      expect(row.batchId).toBe('hn-launch')
      expect(row.durationDays).toBe(30)
      expect(row.monthlyIncludedUsd).toBe(50)
      expect(row.freeSeats).toBe(2)
      expect(row.expiresAt).toEqual(expiresAt)
      expect(row.note).toBe('HN launch giveaway')
      expect(row.createdByUserId).toBe('admin-1')
    }
  })
})

// ============================================================================
// redeemLicenseKey
// ============================================================================

async function mintOne(opts: Partial<Parameters<typeof mintLicenseKeys>[0]> = {}) {
  const [k] = await mintLicenseKeys({ count: 1, planId: 'pro', ...opts })
  return k
}

describe('redeemLicenseKey', () => {
  it('returns not_found when code is invalid', async () => {
    await expect(
      redeemLicenseKey({ code: 'SHGO-PRO-XXXX-XXXX-XXXX', workspaceId: 'ws1', userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('creates a WorkspaceGrant with the key plan + duration', async () => {
    const k = await mintOne({ planId: 'pro', durationDays: 30, monthlyIncludedUsd: 25, freeSeats: 1 })
    const now = new Date('2026-06-01T00:00:00Z')
    const res = await redeemLicenseKey({
      code: k.plaintext,
      workspaceId: 'ws-redeemer',
      userId: 'u-redeemer',
      now,
    })
    expect(res.planId).toBe('pro')
    expect(grants).toHaveLength(1)
    const g = grants[0]
    expect(g.workspaceId).toBe('ws-redeemer')
    expect(g.planId).toBe('pro')
    expect(g.monthlyIncludedUsd).toBe(25)
    expect(g.freeSeats).toBe(1)
    expect(g.startsAt).toEqual(now)
    expect(g.expiresAt).toEqual(new Date(now.getTime() + 30 * 86_400_000))
    expect(g.note).toMatch(/License key redemption \(SHGO-PRO-/)
    // Key row stamped with redeem metadata + grant link.
    expect(keys[0].redeemedAt).toEqual(now)
    expect(keys[0].redeemedByWorkspaceId).toBe('ws-redeemer')
    expect(keys[0].redeemedByUserId).toBe('u-redeemer')
    expect(keys[0].redeemedGrantId).toBe(g.id)
  })

  it('creates a perpetual grant when durationDays is null', async () => {
    const k = await mintOne({ durationDays: null })
    await redeemLicenseKey({ code: k.plaintext, workspaceId: 'ws-x', userId: null })
    expect(grants[0].expiresAt).toBeNull()
  })

  it('is case- and whitespace-insensitive on the plaintext', async () => {
    const k = await mintOne()
    const res = await redeemLicenseKey({
      code: `   ${k.plaintext.toLowerCase()}\n`,
      workspaceId: 'ws-y',
      userId: 'u-y',
    })
    expect(res.planId).toBe('pro')
  })

  it('rejects the second redemption attempt (single-use)', async () => {
    const k = await mintOne()
    await redeemLicenseKey({ code: k.plaintext, workspaceId: 'ws-a', userId: 'u-a' })
    await expect(
      redeemLicenseKey({ code: k.plaintext, workspaceId: 'ws-b', userId: 'u-b' }),
    ).rejects.toMatchObject({ code: 'already_redeemed' })
    // Only one grant created.
    expect(grants).toHaveLength(1)
    expect(grants[0].workspaceId).toBe('ws-a')
  })

  it('atomically serializes concurrent redemptions to the same key', async () => {
    const k = await mintOne()
    const results = await Promise.allSettled([
      redeemLicenseKey({ code: k.plaintext, workspaceId: 'ws-a', userId: 'u-a' }),
      redeemLicenseKey({ code: k.plaintext, workspaceId: 'ws-b', userId: 'u-b' }),
      redeemLicenseKey({ code: k.plaintext, workspaceId: 'ws-c', userId: 'u-c' }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(2)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(LicenseKeyRedeemError)
    }
    expect(grants).toHaveLength(1)
  })

  it('rejects an expired key with expired code', async () => {
    const k = await mintOne({ expiresAt: new Date('2026-05-01T00:00:00Z') })
    await expect(
      redeemLicenseKey({
        code: k.plaintext,
        workspaceId: 'ws-late',
        userId: 'u-late',
        now: new Date('2026-06-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'expired' })
    expect(grants).toHaveLength(0)
  })

  it('does NOT reject a key whose expiresAt is still in the future', async () => {
    const k = await mintOne({ expiresAt: new Date('2027-01-01T00:00:00Z') })
    const res = await redeemLicenseKey({
      code: k.plaintext,
      workspaceId: 'ws-early',
      userId: 'u-early',
      now: new Date('2026-06-01T00:00:00Z'),
    })
    expect(res.planId).toBe('pro')
  })
})

// ============================================================================
// list / revoke
// ============================================================================

describe('listLicenseKeys', () => {
  it('filters by batchId and redeemed state', async () => {
    await mintLicenseKeys({ count: 2, planId: 'pro', batchId: 'A' })
    await mintLicenseKeys({ count: 1, planId: 'pro', batchId: 'B' })
    expect(await listLicenseKeys({ batchId: 'A' })).toHaveLength(2)
    expect(await listLicenseKeys({ batchId: 'B' })).toHaveLength(1)
    expect(await listLicenseKeys({ redeemed: false })).toHaveLength(3)
    expect(await listLicenseKeys({ redeemed: true })).toHaveLength(0)
  })
})

describe('revokeLicenseKey', () => {
  it('sets expiresAt to now, blocking future redemption', async () => {
    const k = await mintOne()
    await revokeLicenseKey(keys[0].id, new Date('2026-06-01T00:00:00Z'))
    await expect(
      redeemLicenseKey({
        code: k.plaintext,
        workspaceId: 'ws-late',
        userId: 'u-late',
        now: new Date('2026-06-02T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'expired' })
  })
})
