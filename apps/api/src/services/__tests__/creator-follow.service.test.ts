// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * creator-follow.service — exhaustive unit tests.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type Profile = {
  id: string; userId: string; displayName: string; bio: string | null
  avatarUrl: string | null; websiteUrl?: string | null; verified: boolean
  creatorTier: string; reputationScore: number; totalAgentsPublished: number
  totalInstalls: number; averageAgentRating: number; followerCount: number
}
type Follow = { id: string; followerId: string; creatorId: string; createdAt: Date }
type User = { id: string; email: string; name?: string }

let profiles: Map<string, Profile>
let follows: Follow[]
let users: Map<string, User>
let nextId = 0
function gen(p='id') { nextId++; return `${p}_${nextId}` }

function projectSelect(row: any, select: any) {
  if (!select || !row) return row
  const out: any = {}
  for (const k of Object.keys(select)) if (select[k]) out[k] = row?.[k]
  return out
}

const prismaStub = {
  $transaction: async (fn: any) => fn(prismaStub),
  creatorProfile: {
    findUnique: async ({ where, select }: any) => {
      const p = profiles.get(where.id)
      if (!p) return null
      return projectSelect(p, select)
    },
    create: async ({ data }: any) => {
      const row = { followerCount: 0, ...data } as Profile
      profiles.set(row.id, row)
      return row
    },
    update: async ({ where, data, select }: any) => {
      const p = profiles.get(where.id)
      if (!p) throw new Error('profile_not_found')
      if (data.followerCount?.increment) p.followerCount += data.followerCount.increment
      if (data.followerCount?.decrement) p.followerCount -= data.followerCount.decrement
      return projectSelect(p, select)
    },
  },
  creatorFollow: {
    findUnique: async ({ where, select }: any) => {
      const key = where.followerId_creatorId
      const row = follows.find(f => f.followerId === key.followerId && f.creatorId === key.creatorId)
      if (!row) return null
      return projectSelect(row, select)
    },
    findMany: async ({ where, orderBy, skip, take, select, include }: any) => {
      let rows = follows.filter(f => !where || f.followerId === where.followerId)
      if (orderBy?.createdAt === 'desc') rows = [...rows].sort((a,b) => b.createdAt.getTime()-a.createdAt.getTime())
      if (typeof skip === 'number') rows = rows.slice(skip)
      if (typeof take === 'number') rows = rows.slice(0, take)
      if (include?.creator) {
        return rows.map(r => ({
          ...r,
          creator: projectSelect(profiles.get(r.creatorId), include.creator.select),
        }))
      }
      if (select) return rows.map(r => projectSelect(r, select))
      return rows
    },
    create: async ({ data }: any) => {
      const row: Follow = { id: gen('cf'), createdAt: new Date(), ...data }
      follows.push(row)
      return row
    },
    delete: async ({ where }: any) => {
      const idx = follows.findIndex(f => f.id === where.id)
      if (idx < 0) throw new Error('not_found')
      const [row] = follows.splice(idx, 1)
      return row
    },
    count: async ({ where }: any) => follows.filter(f => f.followerId === where.followerId).length,
  },
  user: {
    findFirst: async ({ where, select }: any) => {
      for (const u of users.values()) if (u.email === where.email) return projectSelect(u, select)
      return null
    },
    create: async ({ data }: any) => {
      const u: User = { id: gen('u'), ...data }
      users.set(u.id, u)
      return u
    },
  },
}

mock.module('../../lib/prisma', () => ({ prisma: prismaStub }))

import {
  ensureLocalCreatorForFollow, followCreator, unfollowCreator,
  isFollowing, getFollowingCreatorIds, getFollowingCreators, getFollowersCount,
} from '../creator-follow.service'

const origFetch = (globalThis as any).fetch
let fetchImpl: typeof fetch | undefined
beforeEach(() => {
  profiles = new Map()
  follows = []
  users = new Map()
  nextId = 0
  fetchImpl = undefined
  ;(globalThis as any).fetch = (...a: any[]) => (fetchImpl ?? origFetch)(...a as [any])
})

function mkProfile(over: Partial<Profile> = {}): Profile {
  return {
    id: over.id ?? 'cr1', userId: over.userId ?? 'u_owner',
    displayName: 'Creator', bio: null, avatarUrl: null, websiteUrl: null,
    verified: false, creatorTier: 'newcomer', reputationScore: 0,
    totalAgentsPublished: 0, totalInstalls: 0, averageAgentRating: 0,
    followerCount: over.followerCount ?? 0,
    ...over,
  }
}

describe('ensureLocalCreatorForFollow', () => {
  test('no-op when local profile already exists', async () => {
    profiles.set('cr1', mkProfile())
    let fetched = false
    fetchImpl = (async () => { fetched = true; return new Response('', { status: 200 }) }) as any
    await ensureLocalCreatorForFollow('cr1', 'https://cloud.example')
    expect(fetched).toBe(false)
    expect(profiles.size).toBe(1)
  })

  test('non-ok Cloud response → no-op', async () => {
    fetchImpl = (async () => new Response('', { status: 404 })) as any
    await ensureLocalCreatorForFollow('cr1', 'https://cloud.example')
    expect(profiles.size).toBe(0)
    expect(users.size).toBe(0)
  })

  test('fetch throws → swallowed (best-effort)', async () => {
    fetchImpl = (async () => { throw new Error('ENETDOWN') }) as any
    await ensureLocalCreatorForFollow('cr1', 'https://cloud.example')
    expect(profiles.size).toBe(0)
  })

  test('creates placeholder user + profile from Cloud payload', async () => {
    fetchImpl = (async () => new Response(JSON.stringify({
      id: 'cr1', displayName: 'Alice', bio: 'hi',
      avatarUrl: 'http://a/p.png', websiteUrl: 'http://a',
      verified: true, creatorTier: 'expert', reputationScore: 5,
    }), { status: 200 })) as any
    await ensureLocalCreatorForFollow('cr1', 'https://cloud.example')
    expect(profiles.size).toBe(1)
    expect(users.size).toBe(1)
    const u = [...users.values()][0]
    expect(u.email).toBe('cloud-creator-cr1@shogo.local')
    expect(u.name).toBe('Alice')
    const p = profiles.get('cr1')!
    expect(p.displayName).toBe('Alice')
    expect(p.bio).toBe('hi')
    expect(p.avatarUrl).toBe('http://a/p.png')
    expect(p.websiteUrl).toBe('http://a')
    expect(p.verified).toBe(true)
  })

  test('reuses existing placeholder user instead of creating a new one', async () => {
    users.set('u_existing', { id: 'u_existing', email: 'cloud-creator-cr1@shogo.local' })
    fetchImpl = (async () => new Response(JSON.stringify({
      id: 'cr1', displayName: 'Alice',
    }), { status: 200 })) as any
    await ensureLocalCreatorForFollow('cr1', 'https://cloud.example')
    expect(users.size).toBe(1)
    const p = profiles.get('cr1')!
    expect(p.userId).toBe('u_existing')
  })

  test('defaults bio/avatarUrl/websiteUrl/verified when missing from Cloud', async () => {
    fetchImpl = (async () => new Response(JSON.stringify({ id: 'cr1', displayName: 'Alice' }), { status: 200 })) as any
    await ensureLocalCreatorForFollow('cr1', 'https://cloud.example')
    const p = profiles.get('cr1')!
    expect(p.bio).toBeNull()
    expect(p.avatarUrl).toBeNull()
    expect(p.websiteUrl).toBeNull()
    expect(p.verified).toBe(false)
  })
})

describe('followCreator', () => {
  test('throws creator_not_found when no profile', async () => {
    await expect(followCreator('u1', 'missing')).rejects.toThrow('creator_not_found')
  })
  test('throws cannot_follow_self', async () => {
    profiles.set('cr1', mkProfile({ userId: 'u1' }))
    await expect(followCreator('u1', 'cr1')).rejects.toThrow('cannot_follow_self')
  })
  test('inserts follow row + increments followerCount on first follow', async () => {
    profiles.set('cr1', mkProfile({ userId: 'owner', followerCount: 3 }))
    const r = await followCreator('u1', 'cr1')
    expect(r).toEqual({ ok: true, followerCount: 4 })
    expect(follows.length).toBe(1)
  })
  test('no-ops on duplicate follow (idempotent)', async () => {
    profiles.set('cr1', mkProfile({ userId: 'owner', followerCount: 5 }))
    await followCreator('u1', 'cr1')
    const r = await followCreator('u1', 'cr1')
    expect(r.followerCount).toBe(6)
    expect(follows.length).toBe(1)
  })
})

describe('unfollowCreator', () => {
  test('throws creator_not_found when no profile', async () => {
    await expect(unfollowCreator('u1', 'missing')).rejects.toThrow('creator_not_found')
  })
  test('no-op when not following — returns current count', async () => {
    profiles.set('cr1', mkProfile({ followerCount: 7 }))
    const r = await unfollowCreator('u1', 'cr1')
    expect(r).toEqual({ ok: true, followerCount: 7 })
    expect(follows.length).toBe(0)
  })
  test('deletes follow row + decrements followerCount', async () => {
    profiles.set('cr1', mkProfile({ userId: 'owner', followerCount: 4 }))
    follows.push({ id: 'cf1', followerId: 'u1', creatorId: 'cr1', createdAt: new Date() })
    const r = await unfollowCreator('u1', 'cr1')
    expect(r.followerCount).toBe(3)
    expect(follows.length).toBe(0)
  })
  test('clamps to 0 when underlying count drifts negative', async () => {
    profiles.set('cr1', mkProfile({ followerCount: 0 }))
    follows.push({ id: 'cf1', followerId: 'u1', creatorId: 'cr1', createdAt: new Date() })
    const r = await unfollowCreator('u1', 'cr1')
    expect(r.followerCount).toBe(0)
  })
})

describe('isFollowing', () => {
  test('returns false when no row', async () => {
    expect(await isFollowing('u1', 'cr1')).toBe(false)
  })
  test('returns true when row exists', async () => {
    follows.push({ id: 'cf1', followerId: 'u1', creatorId: 'cr1', createdAt: new Date() })
    expect(await isFollowing('u1', 'cr1')).toBe(true)
  })
})

describe('getFollowingCreatorIds', () => {
  test('returns empty set when none', async () => {
    const r = await getFollowingCreatorIds('u1')
    expect(r.size).toBe(0)
  })
  test('returns set of creatorIds for the user only', async () => {
    follows.push({ id: 'a', followerId: 'u1', creatorId: 'cr1', createdAt: new Date() })
    follows.push({ id: 'b', followerId: 'u1', creatorId: 'cr2', createdAt: new Date() })
    follows.push({ id: 'c', followerId: 'u2', creatorId: 'cr3', createdAt: new Date() })
    const r = await getFollowingCreatorIds('u1')
    expect([...r].sort()).toEqual(['cr1', 'cr2'])
  })
})

describe('getFollowingCreators', () => {
  beforeEach(() => {
    profiles.set('cr1', mkProfile({ id: 'cr1', displayName: 'A' }))
    profiles.set('cr2', mkProfile({ id: 'cr2', displayName: 'B' }))
    profiles.set('cr3', mkProfile({ id: 'cr3', displayName: 'C' }))
    follows.push({ id: 'f1', followerId: 'u1', creatorId: 'cr1', createdAt: new Date(2026, 0, 1) })
    follows.push({ id: 'f2', followerId: 'u1', creatorId: 'cr2', createdAt: new Date(2026, 0, 3) })
    follows.push({ id: 'f3', followerId: 'u1', creatorId: 'cr3', createdAt: new Date(2026, 0, 2) })
  })
  test('returns paginated list sorted createdAt desc', async () => {
    const r = await getFollowingCreators('u1')
    expect(r.items.map(i => i.id)).toEqual(['cr2', 'cr3', 'cr1'])
    expect(r.total).toBe(3)
    expect(r.page).toBe(1)
    expect(r.limit).toBe(20)
    expect(r.totalPages).toBe(1)
  })
  test('clamps page to >= 1 and limit to [1, 100]', async () => {
    const r1 = await getFollowingCreators('u1', 0, 0)
    expect(r1.page).toBe(1)
    expect(r1.limit).toBe(1)
    const r2 = await getFollowingCreators('u1', -5, 9999)
    expect(r2.page).toBe(1)
    expect(r2.limit).toBe(100)
  })
  test('paginates via skip+take', async () => {
    const r = await getFollowingCreators('u1', 2, 2)
    expect(r.items.length).toBe(1)
    expect(r.page).toBe(2)
    expect(r.limit).toBe(2)
    expect(r.totalPages).toBe(2)
  })
  test('returns at least totalPages=1 even when no rows', async () => {
    follows = []
    const r = await getFollowingCreators('u_empty')
    expect(r.total).toBe(0)
    expect(r.totalPages).toBe(1)
    expect(r.items).toEqual([])
  })
  test('floor()s fractional page/limit input', async () => {
    const r = await getFollowingCreators('u1', 1.9, 2.7)
    expect(r.page).toBe(1)
    expect(r.limit).toBe(2)
  })
})

describe('getFollowersCount', () => {
  test('returns 0 when profile missing', async () => {
    expect(await getFollowersCount('missing')).toBe(0)
  })
  test('returns stored followerCount', async () => {
    profiles.set('cr1', mkProfile({ followerCount: 42 }))
    expect(await getFollowersCount('cr1')).toBe(42)
  })
})
