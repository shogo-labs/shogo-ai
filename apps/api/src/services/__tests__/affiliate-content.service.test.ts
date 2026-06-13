// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Affiliate content-CPM service + cron tests.
 *
 * Mocks the Prisma surface (in-memory store), the social-content provider
 * (a controllable fake), and the global-job-lock helper. Covers the
 * money-critical paths:
 *   - CPM math on incremental view deltas
 *   - idempotency (re-poll same views pays nothing)
 *   - downward view revisions never go negative / never claw back
 *   - per-post-per-run view cap (viral spike paid over multiple runs)
 *   - per-video lifetime $ cap (per-creator + platform default, seal on hit)
 *   - sub-cent deltas don't advance the high-water mark (no lost views)
 *   - ownership verification via the bio code
 *   - handle-uniqueness (one affiliate per handle)
 *   - cron flag short-circuit + lock-skip behavior
 *
 * Run: bun test apps/api/src/services/__tests__/affiliate-content.service.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

type Row = Record<string, any>

let accounts: Row[]
let posts: Row[]
let snapshots: Row[]
let commissions: Row[]
let affiliates: Map<string, Row>
// In-memory PlatformSetting rows backing the DB-driven content config.
let settingsStore: Map<string, string>

let nextId = 0
function genId(prefix = 'id'): string {
  nextId++
  return `${prefix}_${nextId}`
}
function p2002() {
  const err: any = new Error('Unique constraint failed')
  err.code = 'P2002'
  return err
}

const prismaStub: any = {
  $transaction: async (fn: any) => fn(prismaStub),
  platformSetting: {
    findMany: async ({ where }: any = {}) => {
      let entries = [...settingsStore.entries()]
      if (where?.key?.startsWith) entries = entries.filter(([k]) => k.startsWith(where.key.startsWith))
      if (where?.key?.in) entries = entries.filter(([k]) => where.key.in.includes(k))
      return entries.map(([key, value]) => ({ key, value }))
    },
    findUnique: async ({ where }: any) => {
      const value = settingsStore.get(where.key)
      return value != null ? { key: where.key, value } : null
    },
    upsert: async ({ where, create, update }: any) => {
      const existed = settingsStore.has(where.key)
      const value = String((existed ? update : create).value)
      settingsStore.set(where.key, value)
      return { key: where.key, value }
    },
    deleteMany: async ({ where }: any) => {
      if (where?.key) settingsStore.delete(where.key)
      return {}
    },
  },
  affiliate: {
    findUnique: async ({ where, select }: any) => {
      const row = affiliates.get(where.id) ?? null
      if (!row || !select) return row
      return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]))
    },
    update: async ({ where, data }: any) => {
      const row = affiliates.get(where.id)
      if (!row) throw new Error('affiliate not found')
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && ('increment' in (v as any) || 'decrement' in (v as any))) {
          const delta = ('increment' in (v as any) ? (v as any).increment : -(v as any).decrement) as number
          row[k] = (row[k] ?? 0) + delta
        } else {
          row[k] = v as any
        }
      }
      return row
    },
  },
  affiliateSocialAccount: {
    findUnique: async ({ where }: any) => {
      if (where.platform_handle) {
        return (
          accounts.find(
            (a) => a.platform === where.platform_handle.platform && a.handle === where.platform_handle.handle,
          ) ?? null
        )
      }
      return accounts.find((a) => a.id === where.id) ?? null
    },
    findMany: async ({ where, orderBy }: any) => {
      let rows = accounts.filter((a) => {
        if (where?.affiliateId && a.affiliateId !== where.affiliateId) return false
        if (where?.verificationStatus && a.verificationStatus !== where.verificationStatus) return false
        // Relation filter: only handles whose affiliate is in the requested
        // content-program state (the earning gate added to pollAllVerifiedAccounts).
        const wantStatus = where?.affiliate?.contentProgramStatus
        if (wantStatus) {
          const aff = affiliates.get(a.affiliateId)
          if (!aff || aff.contentProgramStatus !== wantStatus) return false
        }
        return true
      })
      if (orderBy?.createdAt === 'asc') rows = rows.sort((a, b) => +a.createdAt - +b.createdAt)
      return rows
    },
    create: async ({ data }: any) => {
      if (accounts.some((a) => a.platform === data.platform && a.handle === data.handle)) throw p2002()
      const row = { id: genId('sa'), createdAt: new Date(), updatedAt: new Date(), verifiedAt: null, providerUserId: null, lastPolledAt: null, lastError: null, ...data }
      accounts.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = accounts.find((a) => a.id === where.id)
      if (!row) throw new Error('account not found')
      Object.assign(row, data)
      return row
    },
    delete: async ({ where }: any) => {
      const idx = accounts.findIndex((a) => a.id === where.id)
      if (idx >= 0) accounts.splice(idx, 1)
      return {}
    },
    count: async ({ where }: any = {}) =>
      accounts.filter((a) => {
        if (where?.affiliateId && a.affiliateId !== where.affiliateId) return false
        if (where?.verificationStatus && a.verificationStatus !== where.verificationStatus) return false
        return true
      }).length,
  },
  affiliatePost: {
    findUnique: async ({ where }: any) => {
      if (where.platform_providerPostId) {
        return (
          posts.find(
            (p) =>
              p.platform === where.platform_providerPostId.platform &&
              p.providerPostId === where.platform_providerPostId.providerPostId,
          ) ?? null
        )
      }
      return posts.find((p) => p.id === where.id) ?? null
    },
    findMany: async ({ where, orderBy, take }: any) => {
      let rows = posts.filter((p) => {
        if (where?.socialAccountId?.in) return where.socialAccountId.in.includes(p.socialAccountId)
        if (where?.socialAccountId) return p.socialAccountId === where.socialAccountId
        return true
      })
      if (orderBy?.lastViews === 'desc') rows = rows.sort((a, b) => b.lastViews - a.lastViews)
      return take ? rows.slice(0, take) : rows
    },
    create: async ({ data }: any) => {
      const row = { id: genId('post'), createdAt: new Date(), updatedAt: new Date(), ...data }
      posts.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = posts.find((p) => p.id === where.id)
      if (!row) throw new Error('post not found')
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && ('increment' in (v as any) || 'decrement' in (v as any))) {
          const delta = ('increment' in (v as any) ? (v as any).increment : -(v as any).decrement) as number
          row[k] = (row[k] ?? 0) + delta
        } else {
          row[k] = v as any
        }
      }
      return row
    },
  },
  affiliatePostSnapshot: {
    create: async ({ data }: any) => {
      const row = { id: genId('snap'), capturedAt: data.capturedAt ?? new Date(), ...data }
      snapshots.push(row)
      return row
    },
  },
  affiliateCommission: {
    create: async ({ data }: any) => {
      // Enforce the (source, contentRunId, affiliateId) unique index.
      if (
        data.contentRunId != null &&
        commissions.some(
          (c) => c.source === data.source && c.contentRunId === data.contentRunId && c.affiliateId === data.affiliateId,
        )
      ) {
        throw p2002()
      }
      const row = { id: genId('com'), createdAt: new Date(), payoutId: null, ...data }
      commissions.push(row)
      return row
    },
    groupBy: async ({ where, by, _sum }: any) => {
      const filtered = commissions.filter((c) => {
        if (where.affiliateId && c.affiliateId !== where.affiliateId) return false
        if (where.source && c.source !== where.source) return false
        return true
      })
      const buckets = new Map<string, Row>()
      for (const c of filtered) {
        const key = by.map((b: string) => c[b]).join('|')
        let bucket = buckets.get(key)
        if (!bucket) {
          bucket = { ...Object.fromEntries(by.map((b: string) => [b, c[b]])), _sum: {} }
          buckets.set(key, bucket)
        }
        if (_sum) for (const k of Object.keys(_sum)) bucket._sum[k] = (bucket._sum[k] ?? 0) + (c[k] ?? 0)
      }
      return [...buckets.values()]
    },
  },
}

// --- controllable fake provider --------------------------------------------

class FakeProviderError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'SocialProviderError'
  }
}

const fakeProvider = {
  name: 'fake',
  profile: { providerUserId: 'puid-1', bio: '', displayName: 'Tester' } as { providerUserId: string | null; bio: string; displayName: string | null },
  postsToReturn: [] as any[],
  throwOnList: null as Error | null,
  async getProfile() {
    return this.profile
  },
  async listRecentPosts() {
    if (this.throwOnList) throw this.throwOnList
    return this.postsToReturn
  },
}

mock.module('../../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))
mock.module('../social-content', () => ({
  getSocialContentProvider: async () => fakeProvider,
  getConfiguredProviderName: async () => 'ensembledata',
  invalidateSocialContentProvider: () => {},
  ENSEMBLEDATA_SETTING_KEY: 'provider-key.ensembledata',
  SocialProviderError: FakeProviderError,
}))
mock.module('../../lib/global-job-lock', () => ({
  withGlobalJobLock: async (_name: string, body: () => any) => ({ acquired: true, result: await body() }),
  KNOWN_JOB_IDS: {} as Record<string, bigint>,
  jobNameToLockId: () => 0n,
}))

const svc = await import('../affiliate-content.service')
const settingsSvc = await import('../affiliate-content-settings.service')
const job = await import('../../jobs/poll-affiliate-content')

/** Set a content PlatformSetting row and drop the settings cache. */
function setContentSetting(key: string, value: string | number) {
  settingsStore.set(key, String(value))
  settingsSvc.invalidateContentSettings()
}

function makePost(overrides: Partial<Row> = {}): Row {
  return {
    providerPostId: 'v1',
    url: 'https://x/v1',
    caption: 'cap',
    postedAt: new Date('2026-01-01'),
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    ...overrides,
  }
}

beforeEach(() => {
  accounts = []
  posts = []
  snapshots = []
  commissions = []
  affiliates = new Map([
    [
      'aff-1',
      {
        id: 'aff-1',
        userId: 'user-1',
        pendingPayoutCents: 0,
        contentCpmCents: null,
        contentPerVideoCapCents: null,
        // Approved into the video-creator program — earning is gated on this.
        contentProgramStatus: 'approved',
      },
    ],
  ])
  nextId = 0
  fakeProvider.profile = { providerUserId: 'puid-1', bio: '', displayName: 'Tester' }
  fakeProvider.postsToReturn = []
  fakeProvider.throwOnList = null
  // The affiliate program flag stays an env var; everything else is DB-driven.
  process.env.SHOGO_AFFILIATES_NATIVE = 'true'
  // Default content config: feature on, $1.00 / 1k views. Other knobs default.
  settingsStore = new Map([
    ['affiliate.content.enabled', 'true'],
    ['affiliate.content.cpmCents', '100'],
  ])
  settingsSvc.invalidateContentSettings()
})

afterEach(() => {
  delete process.env.SHOGO_AFFILIATES_NATIVE
  settingsSvc.invalidateContentSettings()
})

async function connectVerified(platform = 'tiktok', handle = 'creator') {
  const account = await svc.addSocialAccount('aff-1', platform, handle)
  await prismaStub.affiliateSocialAccount.update({
    where: { id: account.id },
    data: { verificationStatus: 'verified', verifiedAt: new Date() },
  })
  return accounts.find((a) => a.id === account.id)!
}

describe('addSocialAccount', () => {
  test('creates a pending account with a verification code', async () => {
    const a = await svc.addSocialAccount('aff-1', 'tiktok', '@Creator')
    expect(a.handle).toBe('creator')
    expect(a.platform).toBe('tiktok')
    expect(a.verificationStatus).toBe('pending')
    expect(a.verificationCode).toMatch(/^shogo-[0-9a-f]{8}$/)
  })

  test('is idempotent for the same affiliate', async () => {
    const a = await svc.addSocialAccount('aff-1', 'tiktok', 'creator')
    const b = await svc.addSocialAccount('aff-1', 'tiktok', 'creator')
    expect(b.id).toBe(a.id)
    expect(accounts).toHaveLength(1)
  })

  test('rejects a handle claimed by another affiliate', async () => {
    await svc.addSocialAccount('aff-1', 'tiktok', 'creator')
    affiliates.set('aff-2', { id: 'aff-2', userId: 'user-2', pendingPayoutCents: 0 })
    await expect(svc.addSocialAccount('aff-2', 'tiktok', 'creator')).rejects.toMatchObject({ code: 'handle_taken' })
  })

  test('rejects an invalid handle', async () => {
    await expect(svc.addSocialAccount('aff-1', 'tiktok', 'bad handle!!')).rejects.toMatchObject({ code: 'invalid_handle' })
  })
})

describe('verifyAccount', () => {
  test('verifies when the code appears in the bio', async () => {
    const a = await svc.addSocialAccount('aff-1', 'tiktok', 'creator')
    fakeProvider.profile = { providerUserId: 'tt-9', bio: `follow me ${a.verificationCode} thanks`, displayName: 'X' }
    const { verified, account } = await svc.verifyAccount('aff-1', a.id)
    expect(verified).toBe(true)
    expect(account.verificationStatus).toBe('verified')
    expect(account.providerUserId).toBe('tt-9')
  })

  test('stays pending when the code is absent', async () => {
    const a = await svc.addSocialAccount('aff-1', 'tiktok', 'creator')
    fakeProvider.profile = { providerUserId: 'tt-9', bio: 'no code here', displayName: 'X' }
    const { verified, account } = await svc.verifyAccount('aff-1', a.id)
    expect(verified).toBe(false)
    expect(account.verificationStatus).toBe('pending')
  })
})

describe('pollAccount — CPM math', () => {
  test('pays floor(delta/1000 * cpm) on first views and advances paidViews', async () => {
    const account = await connectVerified()
    fakeProvider.postsToReturn = [makePost({ views: 2000 })]
    const res = await svc.pollAccount(account)

    expect(res.postsSeen).toBe(1)
    expect(res.newCommissionCents).toBe(200) // 2000/1000 * 100c
    expect(commissions).toHaveLength(1)
    expect(commissions[0]).toMatchObject({ source: 'content', amountCents: 200, basisCents: 2000, level: 1 })
    expect(posts[0].paidViews).toBe(2000)
    expect(affiliates.get('aff-1')!.pendingPayoutCents).toBe(200)
    expect(snapshots).toHaveLength(1)
  })

  test('re-polling the same views pays nothing (idempotent)', async () => {
    const account = await connectVerified()
    fakeProvider.postsToReturn = [makePost({ views: 2000 })]
    await svc.pollAccount(account)
    const res = await svc.pollAccount(account)
    expect(res.newCommissionCents).toBe(0)
    expect(commissions).toHaveLength(1)
    expect(snapshots).toHaveLength(2) // snapshots still recorded each run
  })

  test('pays only the incremental delta as views grow', async () => {
    const account = await connectVerified()
    fakeProvider.postsToReturn = [makePost({ views: 2000 })]
    await svc.pollAccount(account)
    fakeProvider.postsToReturn = [makePost({ views: 5000 })]
    const res = await svc.pollAccount(account)
    expect(res.newCommissionCents).toBe(300) // delta 3000
    expect(posts[0].paidViews).toBe(5000)
    expect(affiliates.get('aff-1')!.pendingPayoutCents).toBe(500)
  })

  test('never goes negative when views are revised down', async () => {
    const account = await connectVerified()
    fakeProvider.postsToReturn = [makePost({ views: 5000 })]
    await svc.pollAccount(account)
    fakeProvider.postsToReturn = [makePost({ views: 1000 })]
    const res = await svc.pollAccount(account)
    expect(res.newCommissionCents).toBe(0)
    expect(posts[0].paidViews).toBe(5000) // high-water mark held
  })

  test('caps views paid per post per run; remainder paid next run', async () => {
    setContentSetting('affiliate.content.maxViewsPerPostPerRun', 1000)
    const account = await connectVerified()
    fakeProvider.postsToReturn = [makePost({ views: 10000 })]
    const res1 = await svc.pollAccount(account)
    expect(res1.newCommissionCents).toBe(100) // capped to 1000 views
    expect(posts[0].paidViews).toBe(1000)
    const res2 = await svc.pollAccount(account)
    expect(res2.newCommissionCents).toBe(100)
    expect(posts[0].paidViews).toBe(2000)
  })

  test('sub-cent deltas do not advance paidViews (no lost views)', async () => {
    const account = await connectVerified()
    // cpm 100c/1k → 3 views = 0.3c → floors to 0.
    fakeProvider.postsToReturn = [makePost({ views: 3 })]
    const res = await svc.pollAccount(account)
    expect(res.newCommissionCents).toBe(0)
    expect(posts[0].paidViews).toBe(0)
    expect(commissions).toHaveLength(0)
  })

  test('per-creator contentCpmCents override beats the platform rate', async () => {
    affiliates.get('aff-1')!.contentCpmCents = 250 // $2.50 / 1k for this creator
    const account = await connectVerified()
    fakeProvider.postsToReturn = [makePost({ views: 1000 })]
    const res = await svc.pollAccount(account)
    expect(res.newCommissionCents).toBe(250) // 1000/1000 * 250c (not the 100c global)
    expect(commissions[0]).toMatchObject({ rateBps: 250 })
  })

  test('per-platform CPM setting beats the global rate', async () => {
    setContentSetting('affiliate.content.tiktok.cpmCents', 300)
    const account = await connectVerified('tiktok', 'creator')
    fakeProvider.postsToReturn = [makePost({ views: 1000 })]
    const res = await svc.pollAccount(account)
    expect(res.newCommissionCents).toBe(300)
  })

  test('provider failure is isolated and recorded', async () => {
    const account = await connectVerified()
    fakeProvider.throwOnList = new FakeProviderError('rate_limited', 'units exhausted')
    const res = await svc.pollAccount(account)
    expect(res.error).toContain('units exhausted')
    expect(commissions).toHaveLength(0)
    expect(accounts[0].lastError).toContain('units exhausted')
  })

  test('does not accrue when the affiliate is not approved into the program', async () => {
    affiliates.get('aff-1')!.contentProgramStatus = 'pending'
    const account = await connectVerified()
    fakeProvider.postsToReturn = [makePost({ views: 5000 })]
    const res = await svc.pollAccount(account)
    expect(res.error).toBe('content_program_not_approved')
    expect(commissions).toHaveLength(0)
    expect(affiliates.get('aff-1')!.pendingPayoutCents).toBe(0)
  })
})

describe('pollAccount — per-video earnings cap', () => {
  test('per-creator cap clamps a single run and seals the post', async () => {
    // $3.00 lifetime cap; cpm $1.00/1k. 10M views would earn $100, but the cap
    // clamps this run to $3.00 and seals the post (paidViews jumps to lastViews).
    affiliates.get('aff-1')!.contentPerVideoCapCents = 300
    const account = await connectVerified()
    fakeProvider.postsToReturn = [makePost({ views: 10_000_000 })]
    const res = await svc.pollAccount(account)
    expect(res.newCommissionCents).toBe(300)
    expect(commissions).toHaveLength(1)
    expect(commissions[0]).toMatchObject({ amountCents: 300 })
    expect(posts[0].paidCents).toBe(300)
    expect(posts[0].paidViews).toBe(10_000_000) // sealed to latest views
    expect(affiliates.get('aff-1')!.pendingPayoutCents).toBe(300)
  })

  test('accrues normally until the cap, then stops on later runs', async () => {
    affiliates.get('aff-1')!.contentPerVideoCapCents = 500 // $5.00 cap
    const account = await connectVerified()
    // Run 1: 3000 views → $3.00 (under cap).
    fakeProvider.postsToReturn = [makePost({ views: 3000 })]
    const res1 = await svc.pollAccount(account)
    expect(res1.newCommissionCents).toBe(300)
    expect(posts[0].paidCents).toBe(300)
    expect(posts[0].paidViews).toBe(3000)
    // Run 2: grows to 9000 views → would be +$6.00, but only $2.00 of cap left.
    fakeProvider.postsToReturn = [makePost({ views: 9000 })]
    const res2 = await svc.pollAccount(account)
    expect(res2.newCommissionCents).toBe(200)
    expect(posts[0].paidCents).toBe(500) // cap reached exactly
    expect(posts[0].paidViews).toBe(9000) // sealed
    // Run 3: more views, nothing left to pay.
    fakeProvider.postsToReturn = [makePost({ views: 20000 })]
    const res3 = await svc.pollAccount(account)
    expect(res3.newCommissionCents).toBe(0)
    expect(posts[0].paidCents).toBe(500)
    expect(affiliates.get('aff-1')!.pendingPayoutCents).toBe(500)
    expect(commissions).toHaveLength(2)
  })

  test('platform-default cap applies when the creator has no override', async () => {
    setContentSetting('affiliate.content.perVideoCapCents', 150) // $1.50 default
    const account = await connectVerified()
    fakeProvider.postsToReturn = [makePost({ views: 1_000_000 })]
    const res = await svc.pollAccount(account)
    expect(res.newCommissionCents).toBe(150)
    expect(posts[0].paidCents).toBe(150)
  })

  test('per-creator cap overrides the platform default', async () => {
    setContentSetting('affiliate.content.perVideoCapCents', 150) // platform $1.50
    affiliates.get('aff-1')!.contentPerVideoCapCents = 400 // creator $4.00 wins
    const account = await connectVerified()
    fakeProvider.postsToReturn = [makePost({ views: 1_000_000 })]
    const res = await svc.pollAccount(account)
    expect(res.newCommissionCents).toBe(400)
    expect(posts[0].paidCents).toBe(400)
  })

  test('no cap (null) earns the full CPM amount', async () => {
    const account = await connectVerified()
    fakeProvider.postsToReturn = [makePost({ views: 50_000 })]
    const res = await svc.pollAccount(account)
    expect(res.newCommissionCents).toBe(5000) // 50k/1k * 100c, uncapped
    expect(posts[0].paidCents).toBe(5000)
  })
})

describe('applyToContentProgram', () => {
  test('moves none → pending when a verified handle exists', async () => {
    affiliates.get('aff-1')!.contentProgramStatus = 'none'
    await connectVerified()
    const { status } = await svc.applyToContentProgram('aff-1')
    expect(status).toBe('pending')
    expect(affiliates.get('aff-1')!.contentProgramStatus).toBe('pending')
    expect(affiliates.get('aff-1')!.contentAppliedAt).toBeInstanceOf(Date)
  })

  test('rejects when no verified handle is connected', async () => {
    affiliates.get('aff-1')!.contentProgramStatus = 'none'
    await svc.addSocialAccount('aff-1', 'tiktok', 'unverified') // pending only
    await expect(svc.applyToContentProgram('aff-1')).rejects.toMatchObject({
      code: 'no_verified_account',
    })
  })

  test('is a no-op when already approved', async () => {
    affiliates.get('aff-1')!.contentProgramStatus = 'approved'
    const { status } = await svc.applyToContentProgram('aff-1')
    expect(status).toBe('approved')
  })

  test('re-applies from rejected back to pending', async () => {
    affiliates.get('aff-1')!.contentProgramStatus = 'rejected'
    affiliates.get('aff-1')!.contentRejectionReason = 'low quality'
    await connectVerified()
    const { status } = await svc.applyToContentProgram('aff-1')
    expect(status).toBe('pending')
    expect(affiliates.get('aff-1')!.contentRejectionReason).toBeNull()
  })
})

describe('getContentSummary', () => {
  test('aggregates content earnings by status', async () => {
    const account = await connectVerified()
    fakeProvider.postsToReturn = [makePost({ views: 2000 })]
    await svc.pollAccount(account)
    const summary = await svc.getContentSummary('aff-1')
    expect(summary.accounts).toHaveLength(1)
    expect(summary.posts).toHaveLength(1)
    expect(summary.totals.pendingCents).toBe(200)
    expect(summary.totals.lifetimeViews).toBe(2000)
    expect(summary.totals.paidViews).toBe(2000)
  })
})

describe('poll-affiliate-content cron', () => {
  test('polls all verified accounts under the lock', async () => {
    await connectVerified('tiktok', 'creator')
    // an unverified account should be skipped
    await svc.addSocialAccount('aff-1', 'instagram', 'pending_one')
    fakeProvider.postsToReturn = [makePost({ views: 1000 })]
    const res = await job.runPollAffiliateContent()
    expect(res.accountsPolled).toBe(1)
    expect(res.newCommissionCents).toBe(100)
  })

  test('skips verified accounts whose affiliate is not approved', async () => {
    affiliates.get('aff-1')!.contentProgramStatus = 'pending'
    await connectVerified('tiktok', 'creator')
    fakeProvider.postsToReturn = [makePost({ views: 1000 })]
    const res = await job.runPollAffiliateContent()
    expect(res.accountsPolled).toBe(0)
    expect(res.newCommissionCents).toBe(0)
  })
})
