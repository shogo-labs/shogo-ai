// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/services/creator-gamification.service.ts`.
 *
 * Covers all 7 exported functions:
 *   - calculateReputationScore (pure math)
 *   - assignTier (pure thresholds)
 *   - evaluateBadges (awards new badges, never re-awards, sends notifications)
 *   - recalculateCreatorStats (aggregates, derives score+tier, persists)
 *   - getCreatorPublicProfile (shape projection + 404)
 *   - getLeaderboard (pagination clamping + zero state)
 *   - updateMaintenanceStreak (month-window computation w/ grace days)
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { PRISMA_NAMESPACE, withPrismaExports } from './helpers/prisma-mock-exports'

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

const InstallStatus = { active: 'active', uninstalled: 'uninstalled' } as const
const ListingStatus = { published: 'published', draft: 'draft', archived: 'archived' } as const
const NotificationType = { workspace_updated: 'workspace_updated' } as const

// ─── In-memory Prisma ─────────────────────────────────────────────────

let profiles: Map<string, any>
let listings: any[]
let reviews: any[]
let installs: any[]
let versions: any[]
let badges: any[]
let notifications: any[]

function reset() {
  profiles = new Map()
  listings = []
  reviews = []
  installs = []
  versions = []
  badges = []
  notifications = []
}
reset()

const tx = {
  creatorProfile: {
    findUnique: async (args: any) => {
      const p = profiles.get(args.where.id)
      if (!p) return null
      if (args.include?.badges) {
        const order = args.include.badges.orderBy?.earnedAt === 'desc' ? -1 : 1
        const sorted = badges
          .filter((b) => b.creatorId === p.id)
          .slice()
          .sort((a, b) => (a.earnedAt > b.earnedAt ? order : -order))
        return { ...p, badges: sorted }
      }
      return p
    },
    update: async (args: any) => {
      const existing = profiles.get(args.where.id)
      if (!existing) throw new Error('not found')
      const merged = { ...existing, ...args.data }
      profiles.set(args.where.id, merged)
      return merged
    },
    count: async () => profiles.size,
    findMany: async (args: any) => {
      const sorted = Array.from(profiles.values()).sort((a, b) =>
        args.orderBy?.reputationScore === 'desc'
          ? (b.reputationScore ?? 0) - (a.reputationScore ?? 0)
          : 0,
      )
      const skip = args.skip ?? 0
      const take = args.take ?? sorted.length
      return sorted.slice(skip, skip + take)
    },
  },
  creatorBadge: {
    findMany: async (args: any) =>
      badges.filter((b) => b.creatorId === args.where.creatorId),
    create: async (args: any) => {
      const row = { id: `b_${badges.length + 1}`, earnedAt: new Date(), ...args.data }
      badges.push(row)
      return row
    },
  },
  marketplaceListing: {
    findMany: async (args: any) =>
      listings.filter(
        (l) =>
          l.creatorId === args.where.creatorId &&
          (!args.where.status || l.status === args.where.status),
      ),
  },
  marketplaceReview: {
    findFirst: async (args: any) => {
      const matchingListings = listings.filter(
        (l) => l.creatorId === args.where.listing?.creatorId,
      )
      return reviews.find(
        (r) =>
          r.rating === args.where.rating &&
          matchingListings.some((l) => l.id === r.listingId),
      ) ?? null
    },
  },
  marketplaceListingVersion: {
    findMany: async (args: any) => {
      const matchingListings = new Set(
        listings.filter((l) => l.creatorId === args.where.listing?.creatorId).map((l) => l.id),
      )
      return versions.filter((v) => matchingListings.has(v.listingId))
    },
    count: async (args: any) => {
      const ids: string[] = args.where.listingId?.in ?? []
      return versions.filter((v) => ids.includes(v.listingId)).length
    },
  },
  marketplaceInstall: {
    groupBy: async (args: any) => {
      const creatorId = args.where.listing?.creatorId
      const matchingListings = new Set(
        listings.filter((l) => l.creatorId === creatorId).map((l) => l.id),
      )
      const grouped = new Map<string, number>()
      for (const i of installs.filter((i) => matchingListings.has(i.listingId))) {
        grouped.set(i.status, (grouped.get(i.status) ?? 0) + 1)
      }
      return Array.from(grouped.entries()).map(([status, n]) => ({
        status,
        _count: { _all: n },
      }))
    },
  },
  creatorProfile_count_earlier: undefined as any,
  notification: {
    create: async (args: any) => {
      const row = { id: `n_${notifications.length + 1}`, ...args.data }
      notifications.push(row)
      return row
    },
  },
}

// Override the inner count for "earlier profiles" path on the same table key
const prismaStub: any = {
  ...tx,
  creatorProfile: {
    ...tx.creatorProfile,
    count: async (args?: any) => {
      if (args?.where?.OR) {
        const creator = profiles.get(
          args.where.OR[1].id?.lt ?? args.where.OR[1].id?.in?.[0] ?? '__none__',
        )
        const before = Array.from(profiles.values()).filter(
          (p) =>
            (creator && p.createdAt < creator.createdAt) ||
            (creator && p.createdAt.getTime() === creator.createdAt.getTime() && p.id < creator.id),
        )
        return before.length
      }
      return profiles.size
    },
  },
  $transaction: async (queries: any[]) => Promise.all(queries.map((p) => p)),
}

mock.module('../lib/prisma', () => ({
  ...withPrismaExports({ prisma: prismaStub, Prisma: PRISMA_NAMESPACE }),
  BadgeType,
  CreatorTier,
  InstallStatus,
  ListingStatus,
  NotificationType,
}))

const svc = await import('../services/creator-gamification.service')

beforeEach(() => {
  reset()
})

// ──────────────────────────────────────────────────────────────────────
// calculateReputationScore — pure
// ──────────────────────────────────────────────────────────────────────

describe('calculateReputationScore', () => {
  const zero = {
    agentsPublished: 0,
    totalInstalls: 0,
    averageRating: 0,
    versionsShipped: 0,
    maintenanceStreakMonths: 0,
    activeInstalls: 0,
    totalInstallRecords: 0,
  }

  test('all zeros → 0', () => {
    expect(svc.calculateReputationScore(zero)).toBe(0)
  })

  test('caps at 1000 with extreme inputs', () => {
    const big = {
      agentsPublished: 1000,
      totalInstalls: 1_000_000_000,
      averageRating: 5,
      versionsShipped: 10_000,
      maintenanceStreakMonths: 120,
      activeInstalls: 500,
      totalInstallRecords: 500,
    }
    expect(svc.calculateReputationScore(big)).toBe(1000)
  })

  test('retention contribution is zero when totalInstallRecords=0', () => {
    const a = svc.calculateReputationScore({ ...zero, averageRating: 5 })
    expect(a).toBe(250)
  })

  test('agentsPublished saturates at 10 → 100 points', () => {
    expect(svc.calculateReputationScore({ ...zero, agentsPublished: 10 })).toBe(100)
    expect(svc.calculateReputationScore({ ...zero, agentsPublished: 100 })).toBe(100)
  })

  test('maintenanceStreak saturates at 12 → 150 points', () => {
    expect(svc.calculateReputationScore({ ...zero, maintenanceStreakMonths: 12 })).toBe(150)
    expect(svc.calculateReputationScore({ ...zero, maintenanceStreakMonths: 24 })).toBe(150)
  })

  test('result is always an integer', () => {
    const r = svc.calculateReputationScore({
      ...zero,
      agentsPublished: 3,
      totalInstalls: 47,
      averageRating: 3.5,
      versionsShipped: 5,
    })
    expect(Number.isInteger(r)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────
// assignTier — pure thresholds
// ──────────────────────────────────────────────────────────────────────

describe('assignTier', () => {
  test.each([
    [0, CreatorTier.newcomer],
    [99, CreatorTier.newcomer],
    [100, CreatorTier.builder],
    [299, CreatorTier.builder],
    [300, CreatorTier.craftsman],
    [549, CreatorTier.craftsman],
    [550, CreatorTier.expert],
    [799, CreatorTier.expert],
    [800, CreatorTier.master],
    [1000, CreatorTier.master],
  ])('score=%i → tier=%s', (score, tier) => {
    expect(svc.assignTier(score as number)).toBe(tier as any)
  })
})

// ──────────────────────────────────────────────────────────────────────
// evaluateBadges
// ──────────────────────────────────────────────────────────────────────

describe('evaluateBadges', () => {
  function seedCreator(id = 'c1', userId = 'u1', createdAt = new Date('2025-01-01')) {
    profiles.set(id, {
      id,
      userId,
      createdAt,
      displayName: 'Cool',
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
    })
  }

  test('no-ops when creator profile is missing', async () => {
    await svc.evaluateBadges('missing', {
      totalAgentsPublished: 5,
      totalVersionsShipped: 1,
      activeMaintenanceStreak: 1,
      verified: false,
    })
    expect(badges).toHaveLength(0)
  })

  test('awards first_agent + popular_10 + early_adopter + creates notifications', async () => {
    seedCreator()
    listings.push({
      id: 'l1',
      creatorId: 'c1',
      status: ListingStatus.published,
      installCount: 25,
      averageRating: 4.0,
      reviewCount: 2,
      category: 'productivity',
    })
    await svc.evaluateBadges('c1', {
      totalAgentsPublished: 1,
      totalVersionsShipped: 0,
      activeMaintenanceStreak: 0,
      verified: false,
    })
    const types = badges.map((b) => b.badgeType).sort()
    expect(types).toContain(BadgeType.first_agent)
    expect(types).toContain(BadgeType.popular_10)
    expect(types).toContain(BadgeType.early_adopter)
    expect(notifications).toHaveLength(badges.length)
    expect(notifications[0].type).toBe(NotificationType.workspace_updated)
  })

  test('does not re-award badges that already exist', async () => {
    seedCreator()
    badges.push({ id: 'b0', creatorId: 'c1', badgeType: BadgeType.first_agent, earnedAt: new Date() })
    listings.push({
      id: 'l1',
      creatorId: 'c1',
      status: ListingStatus.published,
      installCount: 0,
      averageRating: 0,
      reviewCount: 0,
      category: 'x',
    })
    await svc.evaluateBadges('c1', {
      totalAgentsPublished: 1,
      totalVersionsShipped: 0,
      activeMaintenanceStreak: 0,
      verified: false,
    })
    const firstAgentBadges = badges.filter((b) => b.badgeType === BadgeType.first_agent)
    expect(firstAgentBadges).toHaveLength(1)
  })

  test('multi_category: requires >= 3 distinct non-empty categories', async () => {
    seedCreator()
    for (const cat of ['a', 'b', 'c', '', null]) {
      listings.push({
        id: `l_${cat}`,
        creatorId: 'c1',
        status: ListingStatus.published,
        installCount: 0,
        averageRating: 0,
        reviewCount: 0,
        category: cat,
      })
    }
    await svc.evaluateBadges('c1', {
      totalAgentsPublished: 5,
      totalVersionsShipped: 0,
      activeMaintenanceStreak: 0,
      verified: false,
    })
    expect(badges.map((b) => b.badgeType)).toContain(BadgeType.multi_category)
  })

  test('top_rated requires avg>=4.8 AND reviewCount>=10', async () => {
    seedCreator()
    listings.push({
      id: 'l1',
      creatorId: 'c1',
      status: ListingStatus.published,
      installCount: 0,
      averageRating: 4.9,
      reviewCount: 5, // not enough
      category: 'x',
    })
    await svc.evaluateBadges('c1', {
      totalAgentsPublished: 1,
      totalVersionsShipped: 0,
      activeMaintenanceStreak: 0,
      verified: false,
    })
    expect(badges.map((b) => b.badgeType)).not.toContain(BadgeType.top_rated)
  })

  test('streak + verified badges award when thresholds met', async () => {
    seedCreator()
    await svc.evaluateBadges('c1', {
      totalAgentsPublished: 11,
      totalVersionsShipped: 25,
      activeMaintenanceStreak: 12,
      verified: true,
    })
    const types = badges.map((b) => b.badgeType)
    expect(types).toContain(BadgeType.prolific_builder)
    expect(types).toContain(BadgeType.master_builder)
    expect(types).toContain(BadgeType.active_maintainer)
    expect(types).toContain(BadgeType.streak_3)
    expect(types).toContain(BadgeType.streak_6)
    expect(types).toContain(BadgeType.streak_12)
    expect(types).toContain(BadgeType.verified_creator)
  })
})

// ──────────────────────────────────────────────────────────────────────
// recalculateCreatorStats
// ──────────────────────────────────────────────────────────────────────

describe('recalculateCreatorStats', () => {
  test('returns null when creator missing', async () => {
    expect(await svc.recalculateCreatorStats('ghost')).toBeNull()
  })

  test('zero listings: writes zeroed stats + newcomer tier', async () => {
    profiles.set('c1', {
      id: 'c1',
      userId: 'u1',
      createdAt: new Date('2025-01-01'),
      verified: false,
      activeMaintenanceStreak: 0,
    })
    const out = await svc.recalculateCreatorStats('c1')
    expect(out).toBeTruthy()
    expect(profiles.get('c1').totalAgentsPublished).toBe(0)
    expect(profiles.get('c1').reputationScore).toBe(0)
    expect(profiles.get('c1').creatorTier).toBe(CreatorTier.newcomer)
  })

  test('computes weighted average rating across listings', async () => {
    profiles.set('c1', {
      id: 'c1',
      userId: 'u1',
      createdAt: new Date('2025-01-01'),
      verified: false,
      activeMaintenanceStreak: 0,
    })
    listings.push(
      { id: 'l1', creatorId: 'c1', status: ListingStatus.published, installCount: 100, averageRating: 5, reviewCount: 10 },
      { id: 'l2', creatorId: 'c1', status: ListingStatus.published, installCount: 50, averageRating: 3, reviewCount: 5 },
    )
    installs.push(
      { id: 'i1', listingId: 'l1', status: InstallStatus.active },
      { id: 'i2', listingId: 'l1', status: InstallStatus.active },
    )
    await svc.recalculateCreatorStats('c1')
    // Weighted avg = (5*10 + 3*5) / 15 = 65/15 ≈ 4.333
    expect(profiles.get('c1').averageAgentRating).toBeCloseTo(4.333, 2)
    expect(profiles.get('c1').totalInstalls).toBe(150)
    expect(profiles.get('c1').totalAgentsPublished).toBe(2)
  })

  test('skips version count when no listings (no DB call needed)', async () => {
    profiles.set('c1', {
      id: 'c1',
      userId: 'u1',
      createdAt: new Date(),
      verified: false,
      activeMaintenanceStreak: 0,
    })
    versions.push({ listingId: 'l_unrelated', createdAt: new Date() })
    await svc.recalculateCreatorStats('c1')
    expect(profiles.get('c1').totalVersionsShipped).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────
// getCreatorPublicProfile
// ──────────────────────────────────────────────────────────────────────

describe('getCreatorPublicProfile', () => {
  test('returns null when not found', async () => {
    expect(await svc.getCreatorPublicProfile('nope')).toBeNull()
  })

  test('projects only public fields + flattens badges', async () => {
    profiles.set('c1', {
      id: 'c1',
      userId: 'u1',
      createdAt: new Date(),
      displayName: 'Cool',
      bio: 'About me',
      avatarUrl: 'http://a',
      websiteUrl: 'http://w',
      verified: true,
      creatorTier: CreatorTier.expert,
      reputationScore: 600,
      totalAgentsPublished: 4,
      totalInstalls: 500,
      averageAgentRating: 4.5,
    })
    badges.push(
      { id: 'b1', creatorId: 'c1', badgeType: BadgeType.first_agent, earnedAt: new Date('2025-01-01'), metadata: { k: 'v' } },
      { id: 'b2', creatorId: 'c1', badgeType: BadgeType.popular_10, earnedAt: new Date('2025-02-01'), metadata: null },
    )
    const out = await svc.getCreatorPublicProfile('c1')
    expect(out).toMatchObject({
      id: 'c1',
      displayName: 'Cool',
      verified: true,
      creatorTier: CreatorTier.expert,
      reputationScore: 600,
    })
    expect(out!.badges).toHaveLength(2)
    expect((out as any).userId).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────────
// getLeaderboard
// ──────────────────────────────────────────────────────────────────────

describe('getLeaderboard', () => {
  beforeEach(() => {
    for (let i = 1; i <= 25; i++) {
      profiles.set(`c${i}`, {
        id: `c${i}`,
        userId: `u${i}`,
        displayName: `C${i}`,
        avatarUrl: null,
        creatorTier: CreatorTier.builder,
        reputationScore: i * 10,
        totalAgentsPublished: i,
        totalInstalls: i * 5,
        createdAt: new Date(),
      })
    }
  })

  test('clamps page<1 → 1, returns page 1 default', async () => {
    const out = await svc.getLeaderboard(0, 10)
    expect(out.page).toBe(1)
    expect(out.limit).toBe(10)
    expect(out.items).toHaveLength(10)
    expect(out.total).toBe(25)
    expect(out.totalPages).toBe(3)
  })

  test('clamps limit > 100 → 100', async () => {
    const out = await svc.getLeaderboard(1, 500)
    expect(out.limit).toBe(100)
  })

  test('clamps limit < 1 → 1', async () => {
    const out = await svc.getLeaderboard(1, 0)
    expect(out.limit).toBe(1)
    expect(out.items).toHaveLength(1)
  })

  test('zero state: totalPages=0 when no creators', async () => {
    profiles.clear()
    const out = await svc.getLeaderboard(1, 10)
    expect(out.total).toBe(0)
    expect(out.totalPages).toBe(0)
  })

  test('orders by reputationScore desc', async () => {
    const out = await svc.getLeaderboard(1, 5)
    expect(out.items[0].reputationScore).toBe(250)
    expect(out.items[4].reputationScore).toBe(210)
  })
})

// ──────────────────────────────────────────────────────────────────────
// updateMaintenanceStreak
// ──────────────────────────────────────────────────────────────────────

describe('updateMaintenanceStreak', () => {
  test('no-op when creator missing', async () => {
    await svc.updateMaintenanceStreak('ghost')
    expect(profiles.size).toBe(0)
  })

  test('no versions → streak=0', async () => {
    profiles.set('c1', { id: 'c1', userId: 'u1', activeMaintenanceStreak: 5, createdAt: new Date() })
    listings.push({ id: 'l1', creatorId: 'c1', status: ListingStatus.published })
    await svc.updateMaintenanceStreak('c1')
    expect(profiles.get('c1').activeMaintenanceStreak).toBe(0)
  })

  test('versions in current + previous month → streak=2', async () => {
    profiles.set('c1', { id: 'c1', userId: 'u1', activeMaintenanceStreak: 0, createdAt: new Date() })
    listings.push({ id: 'l1', creatorId: 'c1', status: ListingStatus.published })
    const now = new Date()
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15))
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))
    versions.push({ listingId: 'l1', createdAt: thisMonth }, { listingId: 'l1', createdAt: lastMonth })
    await svc.updateMaintenanceStreak('c1')
    expect(profiles.get('c1').activeMaintenanceStreak).toBeGreaterThanOrEqual(2)
  })

  test('only ancient versions → streak=0', async () => {
    profiles.set('c1', { id: 'c1', userId: 'u1', activeMaintenanceStreak: 0, createdAt: new Date() })
    listings.push({ id: 'l1', creatorId: 'c1', status: ListingStatus.published })
    versions.push({ listingId: 'l1', createdAt: new Date('2020-01-15') })
    await svc.updateMaintenanceStreak('c1')
    expect(profiles.get('c1').activeMaintenanceStreak).toBe(0)
  })
})
