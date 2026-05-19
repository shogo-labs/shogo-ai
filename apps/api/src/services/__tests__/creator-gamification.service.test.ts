// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test'

// ─── prisma mock ─────────────────────────────────────────────────────────────

const BadgeType = {
  first_agent: 'first_agent',
  popular_10: 'popular_10',
  popular_100: 'popular_100',
  popular_1000: 'popular_1000',
  top_rated: 'top_rated',
  five_star: 'five_star',
  prolific_builder: 'prolific_builder',
  master_builder: 'master_builder',
  active_maintainer: 'active_maintainer',
  streak_3: 'streak_3',
  streak_6: 'streak_6',
  streak_12: 'streak_12',
  multi_category: 'multi_category',
  early_adopter: 'early_adopter',
  verified_creator: 'verified_creator',
} as const

const CreatorTier = {
  newcomer: 'newcomer',
  builder: 'builder',
  craftsman: 'craftsman',
  expert: 'expert',
  master: 'master',
} as const

const InstallStatus = { active: 'active', cancelled: 'cancelled', expired: 'expired' } as const
const ListingStatus = { draft: 'draft', published: 'published', archived: 'archived' } as const
const NotificationType = { workspace_updated: 'workspace_updated' } as const

type Profile = {
  id: string
  userId: string
  displayName: string
  bio: string | null
  avatarUrl: string | null
  websiteUrl: string | null
  verified: boolean
  creatorTier: string
  reputationScore: number
  totalAgentsPublished: number
  totalInstalls: number
  averageAgentRating: number
  totalVersionsShipped: number
  activeMaintenanceStreak: number
  createdAt: Date
}

type Listing = {
  id: string
  creatorId: string
  status: string
  installCount: number
  averageRating: number
  reviewCount: number
  category: string | null
}

type Badge = { id: string; creatorId: string; badgeType: string; earnedAt: Date; metadata?: unknown }
type Review = { id: string; rating: number; listingId: string }
type Install = { id: string; listingId: string; status: string }
type Version = { id: string; listingId: string; createdAt: Date }
type Notification = { id: string; userId: string; type: string; title: string; message: string; metadata: unknown }

const db = {
  profiles: new Map<string, Profile>(),
  listings: new Map<string, Listing>(),
  badges: [] as Badge[],
  reviews: [] as Review[],
  installs: [] as Install[],
  versions: [] as Version[],
  notifications: [] as Notification[],
}

let nextId = 0

mock.module('../../lib/prisma', () => ({
  prisma: {
    creatorProfile: {
      findUnique: async ({ where, include, select }: any) => {
        const p = db.profiles.get(where.id)
        if (!p) return null
        if (select) {
          const out: any = {}
          for (const k of Object.keys(select)) if (select[k]) out[k] = (p as any)[k]
          return out
        }
        if (include?.badges) {
          let bs = db.badges.filter((b) => b.creatorId === p.id)
          if (include.badges.orderBy?.earnedAt === 'desc') {
            bs = [...bs].sort((a, b) => b.earnedAt.getTime() - a.earnedAt.getTime())
          }
          return { ...p, badges: bs }
        }
        return p
      },
      findMany: async ({ orderBy, skip, take, select }: any) => {
        let rows = [...db.profiles.values()]
        if (orderBy?.reputationScore === 'desc') {
          rows.sort((a, b) => b.reputationScore - a.reputationScore)
        }
        if (typeof skip === 'number') rows = rows.slice(skip)
        if (typeof take === 'number') rows = rows.slice(0, take)
        if (select) {
          return rows.map((r) => {
            const out: any = {}
            for (const k of Object.keys(select)) if (select[k]) out[k] = (r as any)[k]
            return out
          })
        }
        return rows
      },
      count: async ({ where }: any = {}) => {
        if (!where) return db.profiles.size
        // earlier-adopter ranking query: OR: [{createdAt: {lt}}, {createdAt: eq, id: {lt}}]
        if (where.OR) {
          let n = 0
          for (const p of db.profiles.values()) {
            for (const clause of where.OR) {
              if (clause.createdAt?.lt && p.createdAt < clause.createdAt.lt) { n++; break }
              if (clause.createdAt instanceof Date && p.createdAt.getTime() === clause.createdAt.getTime()
                && clause.id?.lt && p.id < clause.id.lt) { n++; break }
            }
          }
          return n
        }
        return db.profiles.size
      },
      update: async ({ where, data }: any) => {
        const p = db.profiles.get(where.id)
        if (!p) throw new Error('profile missing')
        Object.assign(p, data)
        return p
      },
    },
    creatorBadge: {
      findMany: async ({ where, select }: any) => {
        const rows = db.badges.filter((b) => b.creatorId === where.creatorId)
        if (select?.badgeType) return rows.map((b) => ({ badgeType: b.badgeType }))
        return rows
      },
      create: async ({ data }: any) => {
        const b: Badge = {
          id: `b_${++nextId}`,
          creatorId: data.creatorId,
          badgeType: data.badgeType,
          earnedAt: new Date(),
          metadata: data.metadata,
        }
        db.badges.push(b)
        return b
      },
    },
    notification: {
      create: async ({ data }: any) => {
        const n: Notification = {
          id: `n_${++nextId}`,
          userId: data.userId,
          type: data.type,
          title: data.title,
          message: data.message,
          metadata: data.metadata,
        }
        db.notifications.push(n)
        return n
      },
    },
    marketplaceListing: {
      findMany: async ({ where, select }: any) => {
        const rows = [...db.listings.values()].filter(
          (l) => l.creatorId === where.creatorId && (where.status == null || l.status === where.status),
        )
        if (select) {
          return rows.map((r) => {
            const out: any = {}
            for (const k of Object.keys(select)) if (select[k]) out[k] = (r as any)[k]
            return out
          })
        }
        return rows
      },
    },
    marketplaceReview: {
      findFirst: async ({ where }: any) => {
        const creatorId = where?.listing?.creatorId
        for (const r of db.reviews) {
          if (where.rating != null && r.rating !== where.rating) continue
          if (creatorId) {
            const L = db.listings.get(r.listingId)
            if (!L || L.creatorId !== creatorId) continue
          }
          return r
        }
        return null
      },
    },
    marketplaceListingVersion: {
      count: async ({ where }: any) => {
        if (where.listingId?.in) {
          const set = new Set<string>(where.listingId.in)
          return db.versions.filter((v) => set.has(v.listingId)).length
        }
        return db.versions.length
      },
      findMany: async ({ where, select }: any) => {
        const creatorId = where?.listing?.creatorId
        const rows = db.versions.filter((v) => {
          if (creatorId == null) return true
          const L = db.listings.get(v.listingId)
          return L?.creatorId === creatorId
        })
        if (select?.createdAt) return rows.map((r) => ({ createdAt: r.createdAt }))
        return rows
      },
    },
    marketplaceInstall: {
      groupBy: async ({ by, where, _count }: any) => {
        const creatorId = where?.listing?.creatorId
        const filtered = db.installs.filter((i) => {
          if (!creatorId) return true
          const L = db.listings.get(i.listingId)
          return L?.creatorId === creatorId
        })
        const buckets = new Map<string, { status: string; _count: { _all: number } }>()
        for (const i of filtered) {
          const key = (by as string[]).map((k) => (i as any)[k]).join('|')
          const cur = buckets.get(key)
          if (cur) cur._count._all++
          else buckets.set(key, { status: i.status, _count: { _all: 1 } })
        }
        return [...buckets.values()]
      },
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  },
  BadgeType,
  CreatorTier,
  InstallStatus,
  ListingStatus,
  NotificationType,
  Prisma: { InputJsonValue: {} },
}))

const svc = await import('../creator-gamification.service')

// ─── helpers ─────────────────────────────────────────────────────────────────

function seedProfile(o: Partial<Profile> & { id: string }): Profile {
  const p: Profile = {
    userId: `u_${o.id}`,
    displayName: 'Creator',
    bio: null,
    avatarUrl: null,
    websiteUrl: null,
    verified: false,
    creatorTier: CreatorTier.newcomer,
    reputationScore: 0,
    totalAgentsPublished: 0,
    totalInstalls: 0,
    averageAgentRating: 0,
    totalVersionsShipped: 0,
    activeMaintenanceStreak: 0,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...o,
  }
  db.profiles.set(p.id, p)
  return p
}

function seedListing(o: Partial<Listing> & { id: string; creatorId: string }): Listing {
  const L: Listing = {
    status: ListingStatus.published,
    installCount: 0,
    averageRating: 0,
    reviewCount: 0,
    category: null,
    ...o,
  }
  db.listings.set(L.id, L)
  return L
}

beforeEach(() => {
  db.profiles.clear()
  db.listings.clear()
  db.badges.length = 0
  db.reviews.length = 0
  db.installs.length = 0
  db.versions.length = 0
  db.notifications.length = 0
  nextId = 0
})

// ─── calculateReputationScore ────────────────────────────────────────────────

describe('calculateReputationScore', () => {
  it('returns 0 when all stats are zero', () => {
    expect(
      svc.calculateReputationScore({
        agentsPublished: 0,
        totalInstalls: 0,
        averageRating: 0,
        versionsShipped: 0,
        maintenanceStreakMonths: 0,
        activeInstalls: 0,
        totalInstallRecords: 0,
      }),
    ).toBe(0)
  })

  it('caps at 1000 when everything is maxed out', () => {
    expect(
      svc.calculateReputationScore({
        agentsPublished: 100,
        totalInstalls: 1_000_000,
        averageRating: 5,
        versionsShipped: 10_000,
        maintenanceStreakMonths: 24,
        activeInstalls: 100,
        totalInstallRecords: 100,
      }),
    ).toBe(1000)
  })

  it('clamps to integer in [0, 1000]', () => {
    const score = svc.calculateReputationScore({
      agentsPublished: 5,
      totalInstalls: 500,
      averageRating: 4,
      versionsShipped: 20,
      maintenanceStreakMonths: 6,
      activeInstalls: 70,
      totalInstallRecords: 100,
    })
    expect(Number.isInteger(score)).toBe(true)
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1000)
  })

  it('skips retention points when there are no install records', () => {
    const withRetention = svc.calculateReputationScore({
      agentsPublished: 1, totalInstalls: 1, averageRating: 5, versionsShipped: 0,
      maintenanceStreakMonths: 0, activeInstalls: 1, totalInstallRecords: 1,
    })
    const withoutRetention = svc.calculateReputationScore({
      agentsPublished: 1, totalInstalls: 1, averageRating: 5, versionsShipped: 0,
      maintenanceStreakMonths: 0, activeInstalls: 0, totalInstallRecords: 0,
    })
    expect(withRetention).toBeGreaterThan(withoutRetention)
  })

  it('uses log-scaling for installs (10k installs → ~max install points)', () => {
    const at10k = svc.calculateReputationScore({
      agentsPublished: 0, totalInstalls: 10_000, averageRating: 0, versionsShipped: 0,
      maintenanceStreakMonths: 0, activeInstalls: 0, totalInstallRecords: 0,
    })
    const at1k = svc.calculateReputationScore({
      agentsPublished: 0, totalInstalls: 1_000, averageRating: 0, versionsShipped: 0,
      maintenanceStreakMonths: 0, activeInstalls: 0, totalInstallRecords: 0,
    })
    expect(at10k).toBeGreaterThan(at1k)
    expect(at10k).toBeCloseTo(200, -1) // ~200, log-scaled
  })
})

// ─── assignTier ──────────────────────────────────────────────────────────────

describe('assignTier', () => {
  const cases: Array<[number, string]> = [
    [0, 'newcomer'],
    [99, 'newcomer'],
    [100, 'builder'],
    [299, 'builder'],
    [300, 'craftsman'],
    [549, 'craftsman'],
    [550, 'expert'],
    [799, 'expert'],
    [800, 'master'],
    [1000, 'master'],
  ]
  for (const [score, tier] of cases) {
    it(`score=${score} → ${tier}`, () => {
      expect(svc.assignTier(score)).toBe(tier as any)
    })
  }
})

// ─── evaluateBadges ──────────────────────────────────────────────────────────

describe('evaluateBadges', () => {
  it('no-ops when the profile is missing', async () => {
    await svc.evaluateBadges('missing', {
      totalAgentsPublished: 5,
      totalVersionsShipped: 5,
      activeMaintenanceStreak: 5,
      verified: true,
    })
    expect(db.badges).toHaveLength(0)
  })

  it('awards every eligible badge once and creates matching notifications', async () => {
    const p = seedProfile({ id: 'cp_1', userId: 'u1' })
    seedListing({ id: 'l1', creatorId: p.id, installCount: 1500, averageRating: 4.9, reviewCount: 12, category: 'a' })
    seedListing({ id: 'l2', creatorId: p.id, category: 'b' })
    seedListing({ id: 'l3', creatorId: p.id, category: 'c' })
    db.reviews.push({ id: 'r1', listingId: 'l1', rating: 5 })

    await svc.evaluateBadges(p.id, {
      totalAgentsPublished: 12,
      totalVersionsShipped: 15,
      activeMaintenanceStreak: 12,
      verified: true,
    })

    const types = new Set(db.badges.map((b) => b.badgeType))
    expect(types).toContain('first_agent')
    expect(types).toContain('popular_10')
    expect(types).toContain('popular_100')
    expect(types).toContain('popular_1000')
    expect(types).toContain('top_rated')
    expect(types).toContain('five_star')
    expect(types).toContain('prolific_builder')
    expect(types).toContain('master_builder')
    expect(types).toContain('active_maintainer')
    expect(types).toContain('streak_3')
    expect(types).toContain('streak_6')
    expect(types).toContain('streak_12')
    expect(types).toContain('multi_category')
    expect(types).toContain('early_adopter')
    expect(types).toContain('verified_creator')
    expect(db.badges.length).toBe(db.notifications.length)
    expect(db.notifications[0]!.userId).toBe('u1')
    expect(db.notifications[0]!.title).toMatch(/^Badge earned: /)
    expect((db.notifications[0]!.metadata as any).kind).toBe('badge_earned')
  })

  it('does not re-award badges already earned', async () => {
    const p = seedProfile({ id: 'cp_dup' })
    db.badges.push({
      id: 'b_seed', creatorId: p.id, badgeType: 'first_agent', earnedAt: new Date(),
    })
    await svc.evaluateBadges(p.id, {
      totalAgentsPublished: 1, totalVersionsShipped: 0,
      activeMaintenanceStreak: 0, verified: false,
    })
    expect(db.badges.filter((b) => b.badgeType === 'first_agent')).toHaveLength(1)
  })

  it('does not award streak / popular badges when stats are below threshold', async () => {
    const p = seedProfile({ id: 'cp_low' })
    seedListing({ id: 'l1', creatorId: p.id, installCount: 9, averageRating: 4.7, reviewCount: 5 })
    await svc.evaluateBadges(p.id, {
      totalAgentsPublished: 0, totalVersionsShipped: 0,
      activeMaintenanceStreak: 2, verified: false,
    })
    const types = new Set(db.badges.map((b) => b.badgeType))
    expect(types.has('popular_10')).toBe(false)
    expect(types.has('streak_3')).toBe(false)
    expect(types.has('top_rated')).toBe(false)
    expect(types.has('five_star')).toBe(false)
    expect(types.has('verified_creator')).toBe(false)
  })

  it('considers a profile late-arriving (>=100 earlier) NOT an early adopter', async () => {
    // Seed 100 profiles older than ours.
    const older = new Date('2020-01-01T00:00:00Z')
    for (let i = 0; i < 100; i++) {
      seedProfile({ id: `old_${i}`, createdAt: older })
    }
    seedProfile({ id: 'cp_late', createdAt: new Date('2025-01-01T00:00:00Z') })
    await svc.evaluateBadges('cp_late', {
      totalAgentsPublished: 0, totalVersionsShipped: 0,
      activeMaintenanceStreak: 0, verified: false,
    })
    expect(db.badges.find((b) => b.badgeType === 'early_adopter')).toBeUndefined()
  })

  it('ignores listings whose category is null/empty when counting multi-category', async () => {
    const p = seedProfile({ id: 'cp_cat' })
    seedListing({ id: 'l1', creatorId: p.id, category: null })
    seedListing({ id: 'l2', creatorId: p.id, category: '' })
    seedListing({ id: 'l3', creatorId: p.id, category: 'only-one' })
    await svc.evaluateBadges(p.id, {
      totalAgentsPublished: 3, totalVersionsShipped: 0,
      activeMaintenanceStreak: 0, verified: false,
    })
    expect(db.badges.find((b) => b.badgeType === 'multi_category')).toBeUndefined()
  })
})

// ─── recalculateCreatorStats ─────────────────────────────────────────────────

describe('recalculateCreatorStats', () => {
  it('returns null when the profile is missing', async () => {
    expect(await svc.recalculateCreatorStats('missing')).toBeNull()
  })

  it('updates the profile with computed aggregates and tier from score', async () => {
    const p = seedProfile({ id: 'cp_stats', activeMaintenanceStreak: 4 })
    seedListing({ id: 'l1', creatorId: p.id, installCount: 100, averageRating: 4.5, reviewCount: 10 })
    seedListing({ id: 'l2', creatorId: p.id, installCount: 50, averageRating: 3.5, reviewCount: 5 })
    db.versions.push(
      { id: 'v1', listingId: 'l1', createdAt: new Date() },
      { id: 'v2', listingId: 'l1', createdAt: new Date() },
      { id: 'v3', listingId: 'l2', createdAt: new Date() },
    )
    db.installs.push(
      { id: 'i1', listingId: 'l1', status: 'active' },
      { id: 'i2', listingId: 'l1', status: 'cancelled' },
      { id: 'i3', listingId: 'l2', status: 'active' },
    )
    const out = await svc.recalculateCreatorStats(p.id)
    expect(out).not.toBeNull()
    expect(out!.totalAgentsPublished).toBe(2)
    expect(out!.totalInstalls).toBe(150)
    expect(out!.totalVersionsShipped).toBe(3)
    // Weighted avg: (4.5*10 + 3.5*5) / 15 = 62.5/15 ≈ 4.1667
    expect(out!.averageAgentRating).toBeCloseTo(4.1667, 3)
    expect(out!.reputationScore).toBeGreaterThan(0)
    expect(out!.creatorTier).toBe(svc.assignTier(out!.reputationScore))
  })

  it('handles a creator with no published listings (all zeros, no version count query)', async () => {
    const p = seedProfile({ id: 'cp_empty' })
    const out = await svc.recalculateCreatorStats(p.id)
    expect(out!.totalAgentsPublished).toBe(0)
    expect(out!.totalInstalls).toBe(0)
    expect(out!.totalVersionsShipped).toBe(0)
    expect(out!.averageAgentRating).toBe(0)
  })

  it('sets averageAgentRating to 0 when reviewCount sum is zero', async () => {
    const p = seedProfile({ id: 'cp_noreviews' })
    seedListing({ id: 'l1', creatorId: p.id, installCount: 10, averageRating: 0, reviewCount: 0 })
    const out = await svc.recalculateCreatorStats(p.id)
    expect(out!.averageAgentRating).toBe(0)
  })

  it('calls evaluateBadges with current stats (creates the first_agent badge)', async () => {
    const p = seedProfile({ id: 'cp_evb' })
    seedListing({ id: 'l1', creatorId: p.id, installCount: 0, averageRating: 0, reviewCount: 0 })
    await svc.recalculateCreatorStats(p.id)
    expect(db.badges.find((b) => b.badgeType === 'first_agent')).toBeDefined()
  })
})

// ─── getCreatorPublicProfile ─────────────────────────────────────────────────

describe('getCreatorPublicProfile', () => {
  it('returns null when the profile does not exist', async () => {
    expect(await svc.getCreatorPublicProfile('missing')).toBeNull()
  })

  it('maps fields and includes badges sorted desc by earnedAt', async () => {
    const p = seedProfile({
      id: 'cp_pub', displayName: 'Ada', bio: 'hi', avatarUrl: 'a', websiteUrl: 'w',
      verified: true, creatorTier: 'expert', reputationScore: 600,
      totalAgentsPublished: 3, totalInstalls: 500, averageAgentRating: 4.5,
    })
    db.badges.push(
      { id: 'b1', creatorId: p.id, badgeType: 'first_agent', earnedAt: new Date(2024, 0, 1), metadata: null },
      { id: 'b2', creatorId: p.id, badgeType: 'popular_10', earnedAt: new Date(2024, 6, 1), metadata: { foo: 1 } },
    )
    const out = await svc.getCreatorPublicProfile(p.id)
    expect(out).toEqual({
      id: 'cp_pub',
      displayName: 'Ada',
      bio: 'hi',
      avatarUrl: 'a',
      websiteUrl: 'w',
      verified: true,
      creatorTier: 'expert',
      reputationScore: 600,
      totalAgentsPublished: 3,
      totalInstalls: 500,
      averageAgentRating: 4.5,
      badges: [
        { badgeType: 'popular_10', earnedAt: new Date(2024, 6, 1), metadata: { foo: 1 } },
        { badgeType: 'first_agent', earnedAt: new Date(2024, 0, 1), metadata: null },
      ],
    })
  })
})

// ─── getLeaderboard ──────────────────────────────────────────────────────────

describe('getLeaderboard', () => {
  it('returns empty page with totalPages=0 when there are no profiles', async () => {
    const out = await svc.getLeaderboard(1, 10)
    expect(out).toEqual({ items: [], page: 1, limit: 10, total: 0, totalPages: 0 })
  })

  it('orders by reputationScore desc, paginates, clamps page to >=1 and limit to 1..100', async () => {
    for (let i = 0; i < 5; i++) seedProfile({ id: `cp_${i}`, reputationScore: 100 * i })
    const out = await svc.getLeaderboard(-3, 200)
    expect(out.page).toBe(1)
    expect(out.limit).toBe(100)
    expect(out.total).toBe(5)
    expect(out.items.map((i) => i.id)).toEqual(['cp_4', 'cp_3', 'cp_2', 'cp_1', 'cp_0'])
  })

  it('clamps limit upward when too small', async () => {
    seedProfile({ id: 'cp_a' })
    const out = await svc.getLeaderboard(1, 0)
    expect(out.limit).toBe(1)
    expect(out.items).toHaveLength(1)
  })

  it('paginates correctly across multiple pages', async () => {
    for (let i = 0; i < 7; i++) seedProfile({ id: `cp_${i}`, reputationScore: i })
    const page1 = await svc.getLeaderboard(1, 3)
    const page2 = await svc.getLeaderboard(2, 3)
    const page3 = await svc.getLeaderboard(3, 3)
    expect(page1.totalPages).toBe(3)
    expect(page1.items).toHaveLength(3)
    expect(page2.items).toHaveLength(3)
    expect(page3.items).toHaveLength(1)
  })

  it('floors fractional page numbers', async () => {
    seedProfile({ id: 'cp_a' })
    const out = await svc.getLeaderboard(1.9, 10.7)
    expect(out.page).toBe(1)
    expect(out.limit).toBe(10)
  })
})

// ─── updateMaintenanceStreak ─────────────────────────────────────────────────

describe('updateMaintenanceStreak', () => {
  it('no-ops when the profile is missing', async () => {
    await svc.updateMaintenanceStreak('missing')
    // didn't throw, didn't write anything new
    expect(db.profiles.size).toBe(0)
  })

  it('writes 0 when there are no versions', async () => {
    const p = seedProfile({ id: 'cp_s0', activeMaintenanceStreak: 5 })
    await svc.updateMaintenanceStreak(p.id)
    expect(db.profiles.get(p.id)!.activeMaintenanceStreak).toBe(0)
  })

  it('counts consecutive months ending at the current month', async () => {
    // Pin the clock so the test is deterministic regardless of grace-window
    // edge cases when CI runs on day <= 7.
    setSystemTime(new Date(Date.UTC(2026, 4, 19))) // May 19 2026
    try {
      const p = seedProfile({ id: 'cp_streak' })
      seedListing({ id: 'l1', creatorId: p.id })
      const y = 2026
      const m = 4 // May
      db.versions.push(
        { id: 'v1', listingId: 'l1', createdAt: new Date(Date.UTC(y, m, 5)) },
        { id: 'v2', listingId: 'l1', createdAt: new Date(Date.UTC(y, m - 1, 5)) },
        { id: 'v3', listingId: 'l1', createdAt: new Date(Date.UTC(y, m - 2, 5)) },
        // Gap at m-3
        { id: 'v4', listingId: 'l1', createdAt: new Date(Date.UTC(y, m - 4, 5)) },
      )
      await svc.updateMaintenanceStreak(p.id)
      expect(db.profiles.get(p.id)!.activeMaintenanceStreak).toBe(3)
    } finally {
      setSystemTime()
    }
  })

  describe('with fake system time', () => {
    afterEach(() => {
      setSystemTime() // reset
    })

    it('returns 0 when last version is in a past month and we are past the 7-day grace window', async () => {
      setSystemTime(new Date(Date.UTC(2026, 2, 20))) // Mar 20 2026, day=20 > grace
      const p = seedProfile({ id: 'cp_gap' })
      seedListing({ id: 'l1', creatorId: p.id })
      db.versions.push({
        id: 'v_old', listingId: 'l1',
        createdAt: new Date(Date.UTC(2025, 0, 5)),
      })
      await svc.updateMaintenanceStreak(p.id)
      expect(db.profiles.get(p.id)!.activeMaintenanceStreak).toBe(0)
    })

    it('falls into the grace window (day <= 7): counts streak ending in the previous month', async () => {
      // System time: April 3, 2026 (day=3, within grace).
      setSystemTime(new Date(Date.UTC(2026, 3, 3)))
      const p = seedProfile({ id: 'cp_grace' })
      seedListing({ id: 'l1', creatorId: p.id })
      // No version in April. Versions in March + February → streak ends at
      // March (the prev month) and walks back, so streak = 2.
      db.versions.push(
        { id: 'v1', listingId: 'l1', createdAt: new Date(Date.UTC(2026, 2, 15)) }, // March
        { id: 'v2', listingId: 'l1', createdAt: new Date(Date.UTC(2026, 1, 10)) }, // February
      )
      await svc.updateMaintenanceStreak(p.id)
      expect(db.profiles.get(p.id)!.activeMaintenanceStreak).toBe(2)
    })

    it('grace window with no versions in prev month either returns 0', async () => {
      setSystemTime(new Date(Date.UTC(2026, 3, 3)))
      const p = seedProfile({ id: 'cp_grace_empty' })
      seedListing({ id: 'l1', creatorId: p.id })
      // No versions at all → loop body never executes → streak = 0.
      await svc.updateMaintenanceStreak(p.id)
      expect(db.profiles.get(p.id)!.activeMaintenanceStreak).toBe(0)
    })
  })
})
