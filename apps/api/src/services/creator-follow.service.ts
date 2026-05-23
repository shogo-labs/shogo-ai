// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { prisma } from '../lib/prisma'

/**
 * In local mode, creator profiles live on Cloud. When a user follows a
 * Cloud creator, we fetch the profile from Cloud and upsert a minimal
 * local shadow so the CreatorFollow FK is satisfied.
 */
export async function ensureLocalCreatorForFollow(
  creatorId: string,
  cloudBaseUrl: string,
): Promise<void> {
  const existing = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    select: { id: true },
  })
  if (existing) return

  try {
    const res = await fetch(`${cloudBaseUrl}/api/marketplace/creators/${creatorId}`)
    if (!res.ok) return
    const data = await res.json() as {
      id: string
      displayName: string
      bio?: string | null
      avatarUrl?: string | null
      websiteUrl?: string | null
      verified?: boolean
      creatorTier?: string
      reputationScore?: number
    }
    // We need a userId for the profile. Check if the creator has an associated
    // user locally, otherwise create a placeholder user.
    let userId: string
    const existingUser = await prisma.user.findFirst({
      where: { email: `cloud-creator-${creatorId}@shogo.local` },
      select: { id: true },
    })
    if (existingUser) {
      userId = existingUser.id
    } else {
      const user = await prisma.user.create({
        data: {
          email: `cloud-creator-${creatorId}@shogo.local`,
          name: data.displayName,
        },
      })
      userId = user.id
    }
    await prisma.creatorProfile.create({
      data: {
        id: creatorId,
        userId,
        displayName: data.displayName,
        bio: data.bio ?? null,
        avatarUrl: data.avatarUrl ?? null,
        websiteUrl: data.websiteUrl ?? null,
        verified: data.verified ?? false,
      },
    })
  } catch {
    // Best-effort — if Cloud is unreachable, the follow will fail with creator_not_found
  }
}

export interface FollowResult {
  ok: true
  followerCount: number
}

export interface FollowingCreatorsPage {
  items: FollowingCreatorEntry[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface FollowingCreatorEntry {
  id: string
  displayName: string
  bio: string | null
  avatarUrl: string | null
  verified: boolean
  creatorTier: string
  reputationScore: number
  totalAgentsPublished: number
  totalInstalls: number
  averageAgentRating: number
  followerCount: number
}

export async function followCreator(
  followerId: string,
  creatorId: string,
): Promise<FollowResult> {
  const creator = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    select: { id: true, userId: true, followerCount: true },
  })
  if (!creator) throw new Error('creator_not_found')
  if (creator.userId === followerId) throw new Error('cannot_follow_self')

  // `createMany({ skipDuplicates: true })` compiles to
  // `INSERT ... ON CONFLICT DO NOTHING`, so a same-region double-tap or
  // a retry no-ops at the DB level (no P2002 thrown) and we bump
  // `followerCount` only when we actually inserted a row. The
  // cross-region failover race — two regions both inserting with
  // different PKs but the same `(followerId, creatorId)` — is the
  // residual P2 logged in scripts/check-multiregion-cron-locks.ts:
  // closing it requires a deterministic id of
  // `${followerId}_${creatorId}` so collisions resolve via PK
  // last_update_wins instead of poisoning the apply worker.
  const updated = await prisma.$transaction(async (tx) => {
    const inserted = await tx.creatorFollow.createMany({
      data: [{ followerId, creatorId }],
      skipDuplicates: true,
    })
    if (inserted.count === 0) {
      return { followerCount: creator.followerCount }
    }
    return tx.creatorProfile.update({
      where: { id: creatorId },
      data: { followerCount: { increment: 1 } },
      select: { followerCount: true },
    })
  })
  return { ok: true, followerCount: updated.followerCount }
}

export async function unfollowCreator(
  followerId: string,
  creatorId: string,
): Promise<FollowResult> {
  const creator = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    select: { id: true, followerCount: true },
  })
  if (!creator) throw new Error('creator_not_found')

  const existing = await prisma.creatorFollow.findUnique({
    where: { followerId_creatorId: { followerId, creatorId } },
  })
  if (!existing) {
    return { ok: true, followerCount: creator.followerCount }
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.creatorFollow.delete({
      where: { id: existing.id },
    })
    const profile = await tx.creatorProfile.update({
      where: { id: creatorId },
      data: { followerCount: { decrement: 1 } },
      select: { followerCount: true },
    })
    return profile
  })
  return { ok: true, followerCount: Math.max(0, updated.followerCount) }
}

export async function isFollowing(
  followerId: string,
  creatorId: string,
): Promise<boolean> {
  const row = await prisma.creatorFollow.findUnique({
    where: { followerId_creatorId: { followerId, creatorId } },
    select: { id: true },
  })
  return row != null
}

export async function getFollowingCreatorIds(
  userId: string,
): Promise<Set<string>> {
  const rows = await prisma.creatorFollow.findMany({
    where: { followerId: userId },
    select: { creatorId: true },
  })
  return new Set(rows.map((r) => r.creatorId))
}

export async function getFollowingCreators(
  userId: string,
  page?: number,
  limit?: number,
): Promise<FollowingCreatorsPage> {
  const safePage = Math.max(1, Math.floor(page ?? 1))
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit ?? 20)))
  const skip = (safePage - 1) * safeLimit

  const where = { followerId: userId }
  const [total, rows] = await Promise.all([
    prisma.creatorFollow.count({ where }),
    prisma.creatorFollow.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: safeLimit,
      include: {
        creator: {
          select: {
            id: true,
            displayName: true,
            bio: true,
            avatarUrl: true,
            verified: true,
            creatorTier: true,
            reputationScore: true,
            totalAgentsPublished: true,
            totalInstalls: true,
            averageAgentRating: true,
            followerCount: true,
          },
        },
      },
    }),
  ])

  return {
    items: rows.map((r) => r.creator),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  }
}

export async function getFollowersCount(creatorId: string): Promise<number> {
  const profile = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    select: { followerCount: true },
  })
  return profile?.followerCount ?? 0
}
