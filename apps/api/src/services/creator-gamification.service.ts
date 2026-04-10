// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  prisma,
  BadgeType,
  CreatorTier,
  InstallStatus,
  ListingStatus,
  NotificationType,
  Prisma,
} from '../lib/prisma'

const MAINTENANCE_STREAK_GRACE_DAYS = 7

export type CreatorReputationStats = {
  agentsPublished: number
  totalInstalls: number
  averageRating: number
  versionsShipped: number
  maintenanceStreakMonths: number
  activeInstalls: number
  totalInstallRecords: number
}

export type CreatorBadgeStats = {
  totalAgentsPublished: number
  totalVersionsShipped: number
  activeMaintenanceStreak: number
  verified: boolean
}

export type CreatorPublicProfile = {
  id: string
  displayName: string
  bio: string | null
  avatarUrl: string | null
  websiteUrl: string | null
  verified: boolean
  creatorTier: CreatorTier
  reputationScore: number
  totalAgentsPublished: number
  totalInstalls: number
  averageAgentRating: number
  badges: Array<{
    badgeType: BadgeType
    earnedAt: Date
    metadata: unknown
  }>
}

export type CreatorLeaderboardEntry = {
  id: string
  displayName: string
  avatarUrl: string | null
  creatorTier: CreatorTier
  reputationScore: number
  totalAgentsPublished: number
  totalInstalls: number
}

export type CreatorLeaderboardPage = {
  items: CreatorLeaderboardEntry[]
  page: number
  limit: number
  total: number
  totalPages: number
}

function clamp01(x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  return x
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)))
}

function monthKeyUtc(y: number, m: number): string {
  return `${y}-${m}`
}

function prevMonthUtc(y: number, m: number): { y: number; m: number } {
  const d = new Date(Date.UTC(y, m - 1, 1))
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() }
}

function collectVersionMonthsUtc(dates: Date[]): Set<string> {
  const set = new Set<string>()
  for (const d of dates) {
    set.add(monthKeyUtc(d.getUTCFullYear(), d.getUTCMonth()))
  }
  return set
}

function computeMaintenanceStreakFromVersionDates(
  versionDates: Date[],
  now: Date,
  graceDays: number = MAINTENANCE_STREAK_GRACE_DAYS,
): number {
  const monthsWithVersion = collectVersionMonthsUtc(versionDates)
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const day = now.getUTCDate()
  const hasCurrent = monthsWithVersion.has(monthKeyUtc(y, m))

  if (!hasCurrent && day > graceDays) {
    return 0
  }

  let endY = y
  let endM = m
  if (!hasCurrent && day <= graceDays) {
    const p = prevMonthUtc(y, m)
    endY = p.y
    endM = p.m
  }

  let streak = 0
  let cy = endY
  let cm = endM
  while (monthsWithVersion.has(monthKeyUtc(cy, cm))) {
    streak++
    const p = prevMonthUtc(cy, cm)
    cy = p.y
    cm = p.m
  }
  return streak
}

export function calculateReputationScore(stats: CreatorReputationStats): number {
  const agentsPoints = clamp01(stats.agentsPublished / 10) * 100
  const installPoints =
    clamp01(Math.log1p(stats.totalInstalls) / Math.log1p(10_000)) * 200
  const ratingPoints = clamp01(stats.averageRating / 5) * 250
  const versionPoints =
    clamp01(Math.log1p(stats.versionsShipped) / Math.log1p(100)) * 200
  const streakPoints = clamp01(stats.maintenanceStreakMonths / 12) * 150
  const retentionPct =
    stats.totalInstallRecords > 0
      ? (stats.activeInstalls / stats.totalInstallRecords) * 100
      : 0
  const retentionPoints = clamp01(retentionPct / 100) * 100

  const raw =
    agentsPoints +
    installPoints +
    ratingPoints +
    versionPoints +
    streakPoints +
    retentionPoints

  return clampInt(raw, 0, 1000)
}

export function assignTier(score: number): CreatorTier {
  if (score < 100) return CreatorTier.newcomer
  if (score < 300) return CreatorTier.builder
  if (score < 550) return CreatorTier.craftsman
  if (score < 800) return CreatorTier.expert
  return CreatorTier.master
}

const BADGE_LABELS: Record<BadgeType, string> = {
  [BadgeType.first_agent]: 'First agent',
  [BadgeType.popular_10]: 'Popular (10+ installs)',
  [BadgeType.popular_100]: 'Popular (100+ installs)',
  [BadgeType.popular_1000]: 'Popular (1,000+ installs)',
  [BadgeType.top_rated]: 'Top rated',
  [BadgeType.five_star]: 'Five-star review',
  [BadgeType.prolific_builder]: 'Prolific builder',
  [BadgeType.master_builder]: 'Master builder',
  [BadgeType.active_maintainer]: 'Active maintainer',
  [BadgeType.streak_3]: '3-month streak',
  [BadgeType.streak_6]: '6-month streak',
  [BadgeType.streak_12]: '12-month streak',
  [BadgeType.multi_category]: 'Multi-category',
  [BadgeType.early_adopter]: 'Early adopter',
  [BadgeType.verified_creator]: 'Verified creator',
}

async function awardBadge(
  creatorId: string,
  userId: string,
  badgeType: BadgeType,
  metadata?: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.creatorBadge.create({
    data: {
      creatorId,
      badgeType,
      ...(metadata !== undefined ? { metadata } : {}),
    },
  })
  await prisma.notification.create({
    data: {
      userId,
      type: NotificationType.workspace_updated,
      title: `Badge earned: ${BADGE_LABELS[badgeType]}`,
      message: `You earned the "${BADGE_LABELS[badgeType]}" badge on your creator profile.`,
      metadata: {
        kind: 'badge_earned',
        badgeType,
      } satisfies Prisma.InputJsonValue,
    },
  })
}

export async function evaluateBadges(
  creatorId: string,
  stats: CreatorBadgeStats,
): Promise<void> {
  const creator = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    select: {
      userId: true,
      createdAt: true,
    },
  })
  if (!creator) return

  const existing = await prisma.creatorBadge.findMany({
    where: { creatorId },
    select: { badgeType: true },
  })
  const earned = new Set(existing.map((b) => b.badgeType))

  const publishedListings = await prisma.marketplaceListing.findMany({
    where: { creatorId, status: ListingStatus.published },
    select: {
      installCount: true,
      averageRating: true,
      reviewCount: true,
      category: true,
    },
  })

  const hasFiveStar = await prisma.marketplaceReview.findFirst({
    where: {
      rating: 5,
      listing: { creatorId },
    },
    select: { id: true },
  })

  const earlierProfiles = await prisma.creatorProfile.count({
    where: {
      OR: [
        { createdAt: { lt: creator.createdAt } },
        {
          createdAt: creator.createdAt,
          id: { lt: creatorId },
        },
      ],
    },
  })
  const isEarlyAdopter = earlierProfiles < 100

  const distinctCategories = new Set(
    publishedListings
      .map((l) => l.category)
      .filter((c): c is string => c != null && c.length > 0),
  )

  const tryAward = async (badgeType: BadgeType, eligible: boolean) => {
    if (!eligible || earned.has(badgeType)) return
    earned.add(badgeType)
    await awardBadge(creatorId, creator.userId, badgeType)
  }

  await tryAward(BadgeType.first_agent, stats.totalAgentsPublished >= 1)

  const maxInstalls = publishedListings.reduce(
    (m, l) => Math.max(m, l.installCount),
    0,
  )
  await tryAward(BadgeType.popular_10, maxInstalls >= 10)
  await tryAward(BadgeType.popular_100, maxInstalls >= 100)
  await tryAward(BadgeType.popular_1000, maxInstalls >= 1000)

  const hasTopRated = publishedListings.some(
    (l) => l.averageRating >= 4.8 && l.reviewCount >= 10,
  )
  await tryAward(BadgeType.top_rated, hasTopRated)
  await tryAward(BadgeType.five_star, hasFiveStar != null)

  await tryAward(BadgeType.prolific_builder, stats.totalAgentsPublished >= 5)
  await tryAward(BadgeType.master_builder, stats.totalAgentsPublished >= 10)
  await tryAward(BadgeType.active_maintainer, stats.totalVersionsShipped >= 10)

  await tryAward(BadgeType.streak_3, stats.activeMaintenanceStreak >= 3)
  await tryAward(BadgeType.streak_6, stats.activeMaintenanceStreak >= 6)
  await tryAward(BadgeType.streak_12, stats.activeMaintenanceStreak >= 12)

  await tryAward(BadgeType.multi_category, distinctCategories.size >= 3)
  await tryAward(BadgeType.early_adopter, isEarlyAdopter)
  await tryAward(BadgeType.verified_creator, stats.verified === true)
}

export async function recalculateCreatorStats(creatorId: string) {
  const creator = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
  })
  if (!creator) return null

  const publishedListings = await prisma.marketplaceListing.findMany({
    where: { creatorId, status: ListingStatus.published },
    select: {
      id: true,
      installCount: true,
      averageRating: true,
      reviewCount: true,
    },
  })

  const totalAgentsPublished = publishedListings.length
  const totalInstalls = publishedListings.reduce((s, l) => s + l.installCount, 0)
  const reviewWeight = publishedListings.reduce((s, l) => s + l.reviewCount, 0)
  const averageAgentRating =
    reviewWeight > 0
      ? publishedListings.reduce(
          (s, l) => s + l.averageRating * l.reviewCount,
          0,
        ) / reviewWeight
      : 0

  const listingIds = publishedListings.map((l) => l.id)
  const totalVersionsShipped =
    listingIds.length === 0
      ? 0
      : await prisma.marketplaceListingVersion.count({
          where: { listingId: { in: listingIds } },
        })

  const installAgg = await prisma.marketplaceInstall.groupBy({
    by: ['status'],
    where: { listing: { creatorId } },
    _count: { _all: true },
  })
  let activeInstalls = 0
  let totalInstallRecords = 0
  for (const row of installAgg) {
    totalInstallRecords += row._count._all
    if (row.status === InstallStatus.active) {
      activeInstalls += row._count._all
    }
  }

  const reputationStats: CreatorReputationStats = {
    agentsPublished: totalAgentsPublished,
    totalInstalls,
    averageRating: averageAgentRating,
    versionsShipped: totalVersionsShipped,
    maintenanceStreakMonths: creator.activeMaintenanceStreak,
    activeInstalls,
    totalInstallRecords,
  }

  const reputationScore = calculateReputationScore(reputationStats)
  const creatorTier = assignTier(reputationScore)

  const badgeStats: CreatorBadgeStats = {
    totalAgentsPublished,
    totalVersionsShipped,
    activeMaintenanceStreak: creator.activeMaintenanceStreak,
    verified: creator.verified,
  }
  await evaluateBadges(creatorId, badgeStats)

  return prisma.creatorProfile.update({
    where: { id: creatorId },
    data: {
      totalAgentsPublished,
      totalInstalls,
      averageAgentRating,
      totalVersionsShipped,
      reputationScore,
      creatorTier,
    },
  })
}

export async function getCreatorPublicProfile(
  creatorId: string,
): Promise<CreatorPublicProfile | null> {
  const profile = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    include: {
      badges: { orderBy: { earnedAt: 'desc' } },
    },
  })
  if (!profile) return null

  return {
    id: profile.id,
    displayName: profile.displayName,
    bio: profile.bio,
    avatarUrl: profile.avatarUrl,
    websiteUrl: profile.websiteUrl,
    verified: profile.verified,
    creatorTier: profile.creatorTier,
    reputationScore: profile.reputationScore,
    totalAgentsPublished: profile.totalAgentsPublished,
    totalInstalls: profile.totalInstalls,
    averageAgentRating: profile.averageAgentRating,
    badges: profile.badges.map((b) => ({
      badgeType: b.badgeType,
      earnedAt: b.earnedAt,
      metadata: b.metadata,
    })),
  }
}

export async function getLeaderboard(
  page: number,
  limit: number,
): Promise<CreatorLeaderboardPage> {
  const safePage = Math.max(1, Math.floor(page))
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)))
  const skip = (safePage - 1) * safeLimit

  const [total, rows] = await prisma.$transaction([
    prisma.creatorProfile.count(),
    prisma.creatorProfile.findMany({
      orderBy: { reputationScore: 'desc' },
      skip,
      take: safeLimit,
      select: {
        id: true,
        displayName: true,
        avatarUrl: true,
        creatorTier: true,
        reputationScore: true,
        totalAgentsPublished: true,
        totalInstalls: true,
      },
    }),
  ])

  const totalPages = total === 0 ? 0 : Math.ceil(total / safeLimit)

  return {
    items: rows,
    page: safePage,
    limit: safeLimit,
    total,
    totalPages,
  }
}

export async function updateMaintenanceStreak(creatorId: string): Promise<void> {
  const exists = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    select: { id: true },
  })
  if (!exists) return

  const versionRows = await prisma.marketplaceListingVersion.findMany({
    where: { listing: { creatorId } },
    select: { createdAt: true },
  })
  const streak = computeMaintenanceStreakFromVersionDates(
    versionRows.map((r) => r.createdAt),
    new Date(),
  )

  await prisma.creatorProfile.update({
    where: { id: creatorId },
    data: { activeMaintenanceStreak: streak },
  })
}
