// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/services/creator-follow.service.ts`.
 *
 * Covers:
 *   - followCreator (happy path, idempotent, creator not found, self-follow)
 *   - unfollowCreator (happy path, no-op when not following, creator not found)
 *   - isFollowing (true/false)
 *   - getFollowingCreatorIds (set of IDs)
 *   - getFollowingCreators (pagination)
 *   - getFollowersCount (denormalized read)
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── In-memory state ──────────────────────────────────────────────────

let follows: any[]
let profiles: any[]
let idCounter = 0

function reset() {
  follows = []
  profiles = []
  idCounter = 0
}
reset()

function nextId() {
  idCounter++
  return `id_${idCounter}`
}

// ─── Prisma mock ──────────────────────────────────────────────────────

const creatorFollowTable = {
  create: async (args: any) => {
    const existing = follows.find(
      (f) =>
        f.followerId === args.data.followerId &&
        f.creatorId === args.data.creatorId,
    )
    if (existing) {
      const err: any = new Error('Unique constraint failed')
      err.code = 'P2002'
      throw err
    }
    const row = { id: nextId(), createdAt: new Date(), ...args.data }
    follows.push(row)
    return row
  },
  findUnique: async (args: any) => {
    if (args.where.followerId_creatorId) {
      const { followerId, creatorId } = args.where.followerId_creatorId
      return follows.find(
        (f) => f.followerId === followerId && f.creatorId === creatorId,
      ) ?? null
    }
    return follows.find((f) => f.id === args.where.id) ?? null
  },
  findMany: async (args: any) => {
    let rows = follows.filter((f) => {
      if (args.where?.followerId && f.followerId !== args.where.followerId)
        return false
      return true
    })
    if (args.orderBy?.createdAt === 'desc') {
      rows = [...rows].reverse()
    }
    const skip = args.skip ?? 0
    const take = args.take ?? rows.length
    const sliced = rows.slice(skip, skip + take)
    if (args.include?.creator) {
      return sliced.map((f) => ({
        ...f,
        creator: profiles.find((p) => p.id === f.creatorId) ?? null,
      }))
    }
    return sliced
  },
  count: async (args: any) => {
    return follows.filter((f) => {
      if (args.where?.followerId && f.followerId !== args.where.followerId)
        return false
      if (args.where?.creatorId && f.creatorId !== args.where.creatorId)
        return false
      return true
    }).length
  },
  delete: async (args: any) => {
    const idx = follows.findIndex((f) => f.id === args.where.id)
    if (idx < 0) throw new Error('Not found')
    const [removed] = follows.splice(idx, 1)
    return removed
  },
}

const creatorProfileTable = {
  findUnique: async (args: any) => {
    const profile = profiles.find((p) => p.id === args.where.id) ?? null
    if (!profile) return null
    if (args.select) {
      const result: any = {}
      for (const k of Object.keys(args.select)) {
        result[k] = profile[k]
      }
      return result
    }
    return profile
  },
  update: async (args: any) => {
    const profile = profiles.find((p) => p.id === args.where.id)
    if (!profile) throw new Error('Not found')
    if (args.data.followerCount?.increment) {
      profile.followerCount = (profile.followerCount ?? 0) + args.data.followerCount.increment
    }
    if (args.data.followerCount?.decrement) {
      profile.followerCount = (profile.followerCount ?? 0) - args.data.followerCount.decrement
    }
    if (args.select) {
      const result: any = {}
      for (const k of Object.keys(args.select)) {
        result[k] = profile[k]
      }
      return result
    }
    return profile
  },
}

const txProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'creatorFollow') return creatorFollowTable
      if (prop === 'creatorProfile') return creatorProfileTable
      return undefined
    },
  },
)

const prismaMock = {
  creatorFollow: creatorFollowTable,
  creatorProfile: creatorProfileTable,
  $transaction: async (fn: any) => {
    if (typeof fn === 'function') return fn(txProxy)
    return Promise.all(fn)
  },
}

mock.module('../lib/prisma', () => ({
  prisma: prismaMock,
}))

// ─── Import service under test (after mock is registered) ─────────────

const svc = await import('../services/creator-follow.service')

// ─── Helpers ──────────────────────────────────────────────────────────

function seedProfile(overrides: Partial<any> = {}) {
  const p = {
    id: nextId(),
    userId: nextId(),
    displayName: 'Test Creator',
    bio: null,
    avatarUrl: null,
    verified: false,
    creatorTier: 'newcomer',
    reputationScore: 0,
    totalAgentsPublished: 0,
    totalInstalls: 0,
    averageAgentRating: 0,
    followerCount: 0,
    ...overrides,
  }
  profiles.push(p)
  return p
}

// ─── Tests ────────────────────────────────────────────────────────────

beforeEach(() => reset())

describe('followCreator', () => {
  test('creates follow and increments followerCount', async () => {
    const creator = seedProfile()
    const followerId = 'user_1'
    const result = await svc.followCreator(followerId, creator.id)
    expect(result.ok).toBe(true)
    expect(result.followerCount).toBe(1)
    expect(follows).toHaveLength(1)
    expect(follows[0].followerId).toBe(followerId)
    expect(follows[0].creatorId).toBe(creator.id)
  })

  test('idempotent — second follow returns ok without duplicating', async () => {
    const creator = seedProfile({ followerCount: 1 })
    follows.push({ id: 'existing', followerId: 'user_1', creatorId: creator.id })
    const result = await svc.followCreator('user_1', creator.id)
    expect(result.ok).toBe(true)
    expect(result.followerCount).toBe(1)
    expect(follows).toHaveLength(1)
  })

  test('throws creator_not_found for missing creator', async () => {
    await expect(svc.followCreator('user_1', 'missing_id')).rejects.toThrow(
      'creator_not_found',
    )
  })

  test('throws cannot_follow_self when user is creator owner', async () => {
    const creator = seedProfile({ userId: 'user_self' })
    await expect(svc.followCreator('user_self', creator.id)).rejects.toThrow(
      'cannot_follow_self',
    )
  })
})

describe('unfollowCreator', () => {
  test('removes follow and decrements followerCount', async () => {
    const creator = seedProfile({ followerCount: 1 })
    follows.push({ id: 'f1', followerId: 'user_1', creatorId: creator.id })
    const result = await svc.unfollowCreator('user_1', creator.id)
    expect(result.ok).toBe(true)
    expect(result.followerCount).toBe(0)
    expect(follows).toHaveLength(0)
  })

  test('no-op when not following', async () => {
    const creator = seedProfile({ followerCount: 5 })
    const result = await svc.unfollowCreator('user_1', creator.id)
    expect(result.ok).toBe(true)
    expect(result.followerCount).toBe(5)
  })

  test('throws creator_not_found for missing creator', async () => {
    await expect(svc.unfollowCreator('user_1', 'nope')).rejects.toThrow(
      'creator_not_found',
    )
  })
})

describe('isFollowing', () => {
  test('returns true when follow exists', async () => {
    const creator = seedProfile()
    follows.push({ id: 'f1', followerId: 'user_1', creatorId: creator.id })
    expect(await svc.isFollowing('user_1', creator.id)).toBe(true)
  })

  test('returns false when no follow', async () => {
    const creator = seedProfile()
    expect(await svc.isFollowing('user_1', creator.id)).toBe(false)
  })
})

describe('getFollowingCreatorIds', () => {
  test('returns set of followed creator IDs', async () => {
    follows.push(
      { id: 'f1', followerId: 'user_1', creatorId: 'c1' },
      { id: 'f2', followerId: 'user_1', creatorId: 'c2' },
      { id: 'f3', followerId: 'user_2', creatorId: 'c1' },
    )
    const ids = await svc.getFollowingCreatorIds('user_1')
    expect(ids.size).toBe(2)
    expect(ids.has('c1')).toBe(true)
    expect(ids.has('c2')).toBe(true)
  })
})

describe('getFollowingCreators', () => {
  test('returns paginated creators the user follows', async () => {
    const c1 = seedProfile({ displayName: 'Creator 1' })
    const c2 = seedProfile({ displayName: 'Creator 2' })
    follows.push(
      { id: 'f1', followerId: 'user_1', creatorId: c1.id, createdAt: new Date() },
      { id: 'f2', followerId: 'user_1', creatorId: c2.id, createdAt: new Date() },
    )
    const page = await svc.getFollowingCreators('user_1', 1, 10)
    expect(page.total).toBe(2)
    expect(page.items).toHaveLength(2)
    expect(page.page).toBe(1)
    expect(page.limit).toBe(10)
    expect(page.totalPages).toBe(1)
  })

  test('pagination clamps to valid range', async () => {
    const page = await svc.getFollowingCreators('user_1', -1, 200)
    expect(page.page).toBe(1)
    expect(page.limit).toBe(100)
  })
})

describe('getFollowersCount', () => {
  test('reads denormalized followerCount from profile', async () => {
    seedProfile({ id: 'cp_1', followerCount: 42 })
    expect(await svc.getFollowersCount('cp_1')).toBe(42)
  })

  test('returns 0 for missing profile', async () => {
    expect(await svc.getFollowersCount('missing')).toBe(0)
  })
})
