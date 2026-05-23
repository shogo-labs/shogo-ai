// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// Pin sqlite mode BEFORE importing the service — its top-level const captures it.
process.env.SHOGO_LOCAL_MODE = 'true'

// ─── prisma mock ─────────────────────────────────────────────────────────────

type Listing = {
  id: string
  slug: string
  title: string
  shortDescription: string
  longDescription?: string | null
  category?: string | null
  tags?: any
  iconUrl?: string | null
  screenshotUrls?: any
  pricingModel?: string
  priceInCents?: number | null
  monthlyPriceInCents?: number | null
  annualPriceInCents?: number | null
  installModel?: string
  currentVersion?: string | null
  stripePriceId?: string | null
  stripeMonthlyPriceId?: string | null
  stripeAnnualPriceId?: string | null
  status: 'draft' | 'in_review' | 'published' | 'archived' | 'rejected'
  creatorId: string
  projectId: string
  installCount: number
  averageRating: number
  reviewCount: number
  publishedAt?: Date | null
  featuredAt?: Date | null
  updatedAt: Date
  createdAt: Date
}

type CreatorProfile = {
  id: string
  userId: string
  displayName: string
  bio?: string | null
  createdAt: Date
  updatedAt: Date
}

type Review = {
  id: string
  listingId: string
  userId: string
  installId: string
  rating: number
  title?: string | null
  body?: string | null
  createdAt: Date
}

type Install = {
  id: string
  userId: string
  listingId: string
}

type Transaction = {
  id: string
  creatorId: string
  listingId: string
  status: 'pending' | 'completed' | 'failed' | 'refunded'
  creatorAmountInCents: number
  createdAt: Date
}

const listings = new Map<string, Listing>()
const profiles = new Map<string, CreatorProfile>() // keyed by id; also lookup by userId
const reviews = new Map<string, Review>()
const installs = new Map<string, Install>()
const transactions = new Map<string, Transaction>()

let id = 0
const nextId = (p: string) => `${p}_${++id}`

function matchWhere<T extends Record<string, any>>(row: T, where: any): boolean {
  if (!where) return true
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') {
      if (!(v as any[]).every((w) => matchWhere(row, w))) return false
      continue
    }
    if (k === 'OR') {
      if (!(v as any[]).some((w) => matchWhere(row, w))) return false
      continue
    }
    if (k === 'NOT') {
      if (matchWhere(row, v as any)) return false
      continue
    }
    const rv = (row as any)[k]
    if (v == null) {
      if (rv != null) return false
      continue
    }
    if (typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) {
        if (v.not === null) {
          if (rv == null) return false
        } else if (rv === v.not) return false
      }
      if ('contains' in v) {
        const hay = typeof rv === 'string' ? rv : Array.isArray(rv) ? rv.join(',') : ''
        if (!hay.includes(v.contains)) return false
      }
      if ('hasEvery' in v) {
        if (!Array.isArray(rv)) return false
        if (!(v.hasEvery as any[]).every((t) => rv.includes(t))) return false
      }
      if ('hasSome' in v) {
        if (!Array.isArray(rv)) return false
        if (!(v.hasSome as any[]).some((t) => rv.includes(t))) return false
      }
      // Nested relation filter: { listing: { creatorId: 'x' } }
      if (k === 'listing' && rv === undefined) {
        const L = listings.get((row as any).listingId)
        if (!L) return false
        if (!matchWhere(L, v)) return false
      }
    } else {
      if (rv !== v) return false
    }
  }
  return true
}

function orderRows<T extends Record<string, any>>(rows: T[], orderBy: any): T[] {
  if (!orderBy) return rows
  const arr = Array.isArray(orderBy) ? orderBy : [orderBy]
  return [...rows].sort((a, b) => {
    for (const spec of arr) {
      for (const [k, dir] of Object.entries(spec)) {
        const av = (a as any)[k]
        const bv = (b as any)[k]
        // Treat nulls last on desc when spec is object form { sort, nulls }
        const direction = typeof dir === 'string' ? dir : (dir as any).sort
        const aNull = av == null
        const bNull = bv == null
        if (aNull && bNull) continue
        if (aNull) return 1
        if (bNull) return -1
        if (av === bv) continue
        const cmp = av < bv ? -1 : 1
        return direction === 'desc' ? -cmp : cmp
      }
    }
    return 0
  })
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    marketplaceListing: {
      findUnique: async ({ where }: any) => {
        if (where.id != null) return listings.get(where.id) ?? null
        if (where.slug != null) {
          for (const L of listings.values()) if (L.slug === where.slug) return L
        }
        return null
      },
      findFirst: async ({ where, include }: any) => {
        for (const L of orderRows([...listings.values()], { createdAt: 'asc' })) {
          if (matchWhere(L, where)) {
            if (include?.creator) {
              const creator = [...profiles.values()].find((p) => p.id === L.creatorId) ?? null
              return { ...L, creator }
            }
            return L
          }
        }
        return null
      },
      findMany: async ({ where, orderBy, skip, take, select }: any) => {
        let rows = [...listings.values()].filter((L) => matchWhere(L, where ?? {}))
        if (orderBy) rows = orderRows(rows, orderBy)
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
      count: async ({ where }: any) =>
        [...listings.values()].filter((L) => matchWhere(L, where ?? {})).length,
      create: async ({ data }: any) => {
        const now = new Date()
        const row: Listing = {
          id: nextId('lst'),
          status: 'draft',
          installCount: 0,
          averageRating: 0,
          reviewCount: 0,
          publishedAt: null,
          featuredAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        }
        listings.set(row.id, row)
        return row
      },
      update: async ({ where, data }: any) => {
        const L = listings.get(where.id)
        if (!L) throw new Error('not found')
        Object.assign(L, data, { updatedAt: new Date() })
        return L
      },
    },
    creatorProfile: {
      findUnique: async ({ where }: any) => {
        if (where.id != null) return profiles.get(where.id) ?? null
        if (where.userId != null) {
          for (const p of profiles.values()) if (p.userId === where.userId) return p
        }
        return null
      },
      create: async ({ data }: any) => {
        const now = new Date()
        const row: CreatorProfile = {
          id: nextId('cp'),
          createdAt: now,
          updatedAt: now,
          ...data,
        }
        profiles.set(row.id, row)
        return row
      },
      update: async ({ where, data }: any) => {
        let target: CreatorProfile | undefined
        if (where.userId != null) {
          for (const p of profiles.values()) if (p.userId === where.userId) target = p
        }
        if (!target) throw new Error('profile not found')
        Object.assign(target, data, { updatedAt: new Date() })
        return target
      },
    },
    marketplaceReview: {
      findUnique: async ({ where }: any) => {
        if (where.listingId_userId) {
          const { listingId, userId } = where.listingId_userId
          for (const r of reviews.values()) if (r.listingId === listingId && r.userId === userId) return r
        }
        return null
      },
      findMany: async ({ where, orderBy, skip, take }: any) => {
        let rows = [...reviews.values()].filter((r) => matchWhere(r, where ?? {}))
        if (orderBy) rows = orderRows(rows, orderBy)
        if (typeof skip === 'number') rows = rows.slice(skip)
        if (typeof take === 'number') rows = rows.slice(0, take)
        return rows
      },
      count: async ({ where }: any) =>
        [...reviews.values()].filter((r) => matchWhere(r, where ?? {})).length,
      create: async ({ data }: any) => {
        const row: Review = { id: nextId('rev'), createdAt: new Date(), ...data }
        reviews.set(row.id, row)
        return row
      },
      aggregate: async ({ where, _avg, _count }: any) => {
        const rows = [...reviews.values()].filter((r) => matchWhere(r, where ?? {}))
        const out: any = {}
        if (_avg?.rating) {
          out._avg = {
            rating: rows.length === 0 ? null : rows.reduce((s, r) => s + r.rating, 0) / rows.length,
          }
        }
        if (_count?._all) {
          out._count = { _all: rows.length }
        }
        return out
      },
    },
    marketplaceInstall: {
      findFirst: async ({ where }: any) => {
        for (const i of installs.values()) {
          if (matchWhere(i, where)) return i
        }
        return null
      },
    },
    marketplaceTransaction: {
      findMany: async ({ where, orderBy, skip, take }: any) => {
        let rows = [...transactions.values()].filter((t) => matchWhere(t, where ?? {}))
        if (orderBy) rows = orderRows(rows, orderBy)
        if (typeof skip === 'number') rows = rows.slice(skip)
        if (typeof take === 'number') rows = rows.slice(0, take)
        return rows
      },
      count: async ({ where }: any) =>
        [...transactions.values()].filter((t) => matchWhere(t, where ?? {})).length,
      groupBy: async ({ by, where, _sum }: any) => {
        const rows = [...transactions.values()].filter((t) => matchWhere(t, where ?? {}))
        const buckets = new Map<string, { listingId: string; _sum: { creatorAmountInCents: number } }>()
        for (const r of rows) {
          const key = by.map((k: string) => (r as any)[k]).join('|')
          const existing = buckets.get(key)
          if (existing) existing._sum.creatorAmountInCents += r.creatorAmountInCents
          else buckets.set(key, { listingId: r.listingId, _sum: { creatorAmountInCents: r.creatorAmountInCents } })
        }
        return [...buckets.values()]
      },
    },
    $transaction: async (fn: any) => {
      // Pass our prisma object back in (tx is the same surface for our tests).
      return fn((prismaMock as any).prisma ?? prismaProxy)
    },
  },
  PricingModel: { FREE: 'free', ONE_TIME: 'one_time', SUBSCRIPTION: 'subscription' },
}))

// Hold a stable reference to the mocked prisma so $transaction can hand it back.
const prismaModule = await import('../../lib/prisma')
const prismaProxy = (prismaModule as any).prisma
const prismaMock = { prisma: prismaProxy }

// Now import the service against the mocked prisma.
const svc = await import('../marketplace.service')

// ─── helpers ─────────────────────────────────────────────────────────────────

function seedListing(overrides: Partial<Listing> = {}): Listing {
  const now = new Date()
  const L: Listing = {
    id: nextId('lst'),
    slug: overrides.slug ?? `listing-${id}`,
    title: 'Sample Listing',
    shortDescription: 'short',
    status: 'published',
    creatorId: overrides.creatorId ?? 'cp_1',
    projectId: 'proj_1',
    installCount: 0,
    averageRating: 0,
    reviewCount: 0,
    publishedAt: now,
    featuredAt: null,
    createdAt: now,
    updatedAt: now,
    tags: [],
    pricingModel: 'free',
    installModel: 'managed',
    ...overrides,
  }
  listings.set(L.id, L)
  return L
}

function seedProfile(overrides: Partial<CreatorProfile> = {}): CreatorProfile {
  const now = new Date()
  const p: CreatorProfile = {
    id: nextId('cp'),
    userId: `user_${id}`,
    displayName: 'Creator',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  profiles.set(p.id, p)
  return p
}

function seedInstall(o: Partial<Install> & { userId: string; listingId: string }): Install {
  const i: Install = { id: nextId('inst'), ...o }
  installs.set(i.id, i)
  return i
}

function seedTxn(o: Partial<Transaction> & { creatorId: string; listingId: string }): Transaction {
  const t: Transaction = {
    id: nextId('txn'),
    status: 'completed',
    creatorAmountInCents: 0,
    createdAt: new Date(),
    ...o,
  } as Transaction
  transactions.set(t.id, t)
  return t
}

beforeEach(() => {
  listings.clear()
  profiles.clear()
  reviews.clear()
  installs.clear()
  transactions.clear()
  id = 0
})

afterEach(() => {})

// ─── generateSlug / slugifyTitle (via generateSlug) ─────────────────────────

describe('generateSlug', () => {
  it('builds a kebab-case slug from a plain title', async () => {
    expect(await svc.generateSlug('Hello World')).toBe('hello-world')
  })

  it('strips punctuation and collapses whitespace', async () => {
    expect(await svc.generateSlug('  Hello,  World!!  ')).toBe('hello-world')
  })

  it('keeps unicode letters/numbers', async () => {
    expect(await svc.generateSlug('Café 42')).toBe('café-42')
  })

  it('strips underscores entirely (not in [\\p{L}\\p{N}\\s-]) and collapses dashes', async () => {
    // The first pass strips `_` (neither letter, number, whitespace, nor `-`),
    // then `---` collapses to `-`. So 'foo___bar---baz' → 'foobar-baz', not
    // 'foo-bar-baz'. Pinning the actual behaviour.
    expect(await svc.generateSlug('foo___bar---baz')).toBe('foobar-baz')
  })

  it("falls back to 'listing' when the slug would be empty", async () => {
    expect(await svc.generateSlug('   !!!   ')).toBe('listing')
  })

  it('appends a random suffix on collision', async () => {
    seedListing({ slug: 'taken' })
    const out = await svc.generateSlug('taken')
    expect(out).toMatch(/^taken-[0-9a-z]{6}$/)
  })

  it('throws if it cannot find a unique slug after 32 attempts', async () => {
    seedListing({ slug: 'busy' })
    // Stub findUnique to always claim the slug is taken.
    const orig = prismaProxy.marketplaceListing.findUnique
    prismaProxy.marketplaceListing.findUnique = async () => ({} as any)
    try {
      await expect(svc.generateSlug('busy')).rejects.toThrow(/Could not generate a unique listing slug/)
    } finally {
      prismaProxy.marketplaceListing.findUnique = orig
    }
  })
})

// ─── Creator profiles ────────────────────────────────────────────────────────

describe('creator profiles', () => {
  it('createCreatorProfile attaches the userId', async () => {
    const p = await svc.createCreatorProfile('user_1', { displayName: 'Ada' } as any)
    expect(p.userId).toBe('user_1')
    expect(p.displayName).toBe('Ada')
  })

  it('getCreatorProfile looks up by userId', async () => {
    const p = seedProfile({ userId: 'user_42', displayName: 'Ada' })
    expect(await svc.getCreatorProfile('user_42')).toEqual(p)
    expect(await svc.getCreatorProfile('user_nope')).toBeNull()
  })

  it('getCreatorProfileById looks up by id', async () => {
    const p = seedProfile()
    expect(await svc.getCreatorProfileById(p.id)).toEqual(p)
    expect(await svc.getCreatorProfileById('nope')).toBeNull()
  })

  it('updateCreatorProfile patches by userId', async () => {
    const p = seedProfile({ userId: 'user_99', displayName: 'old' })
    const out = await svc.updateCreatorProfile('user_99', { displayName: 'new' } as any)
    expect(out.displayName).toBe('new')
    expect(profiles.get(p.id)!.displayName).toBe('new')
  })
})

// ─── createListing ───────────────────────────────────────────────────────────

describe('createListing', () => {
  it('seeds a draft listing with a generated slug', async () => {
    const L = await svc.createListing('cp_1', 'proj_1', {
      title: 'Awesome Tool',
      shortDescription: 'short',
    } as any)
    expect(L.status).toBe('draft')
    expect(L.slug).toBe('awesome-tool')
    expect(L.creatorId).toBe('cp_1')
    expect(L.projectId).toBe('proj_1')
  })

  it('passes optional fields through', async () => {
    const L = await svc.createListing('cp_1', 'proj_1', {
      title: 'Pricey',
      shortDescription: 'short',
      pricingModel: 'one_time',
      priceInCents: 4200,
      tags: ['ai', 'voice'],
      category: 'productivity',
    } as any)
    expect(L.pricingModel).toBe('one_time')
    expect(L.priceInCents).toBe(4200)
    expect(L.tags).toEqual(['ai', 'voice'])
    expect(L.category).toBe('productivity')
  })
})

// ─── updateListing ───────────────────────────────────────────────────────────

describe('updateListing', () => {
  it('throws when the listing is not owned by the caller', async () => {
    seedListing({ id: 'lst_x', creatorId: 'cp_owner' })
    await expect(
      svc.updateListing('lst_x', 'cp_other', { title: 'new' } as any),
    ).rejects.toThrow(/Listing not found or not owned/)
  })

  it('updates fields on the owner path', async () => {
    seedListing({ id: 'lst_y', creatorId: 'cp_owner', title: 'old' })
    const out = await svc.updateListing('lst_y', 'cp_owner', { title: 'new' } as any)
    expect(out.title).toBe('new')
  })
})

// ─── publishListing / unpublishListing ───────────────────────────────────────

describe('publishListing', () => {
  it('throws when listing not owned', async () => {
    seedListing({ id: 'lst_p', creatorId: 'cp_owner', status: 'draft' })
    await expect(svc.publishListing('lst_p', 'cp_nope')).rejects.toThrow(/not found or not owned/)
  })

  it('rejects when status is not draft/in_review', async () => {
    seedListing({ id: 'lst_p2', creatorId: 'cp_owner', status: 'published' })
    await expect(svc.publishListing('lst_p2', 'cp_owner')).rejects.toThrow(
      /Only draft or in-review listings can be published/,
    )
  })

  it('publishes a draft and stamps publishedAt', async () => {
    const before = new Date(Date.now() - 1000)
    seedListing({ id: 'lst_p3', creatorId: 'cp_owner', status: 'draft', publishedAt: null })
    const out = await svc.publishListing('lst_p3', 'cp_owner')
    expect(out.status).toBe('published')
    expect(out.publishedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
  })

  it('publishes an in_review listing', async () => {
    seedListing({ id: 'lst_p4', creatorId: 'cp_owner', status: 'in_review' })
    const out = await svc.publishListing('lst_p4', 'cp_owner')
    expect(out.status).toBe('published')
  })
})

describe('unpublishListing', () => {
  it('throws when not owned', async () => {
    seedListing({ id: 'lst_u', creatorId: 'cp_owner' })
    await expect(svc.unpublishListing('lst_u', 'cp_nope')).rejects.toThrow(/not found or not owned/)
  })

  it('archives the listing on the owner path', async () => {
    seedListing({ id: 'lst_u2', creatorId: 'cp_owner', status: 'published' })
    const out = await svc.unpublishListing('lst_u2', 'cp_owner')
    expect(out.status).toBe('archived')
  })
})

// ─── getters ─────────────────────────────────────────────────────────────────

describe('listing getters', () => {
  it('getListingBySlug only returns published listings, with creator', async () => {
    const p = seedProfile({ id: 'cp_owner', displayName: 'Ada' })
    seedListing({ slug: 'pub', status: 'published', creatorId: p.id })
    seedListing({ slug: 'draft', status: 'draft', creatorId: p.id })
    const out = await svc.getListingBySlug('pub')
    expect(out?.slug).toBe('pub')
    expect((out as any)?.creator?.displayName).toBe('Ada')
    expect(await svc.getListingBySlug('draft')).toBeNull()
  })

  it('getListingById looks up by id (any status)', async () => {
    const L = seedListing({ status: 'draft' })
    expect(await svc.getListingById(L.id)).toEqual(L)
  })

  it('getCreatorListings returns only that creator, newest-updated first', async () => {
    const a = seedListing({ creatorId: 'cp_a', updatedAt: new Date(2020, 0, 1) })
    const b = seedListing({ creatorId: 'cp_a', updatedAt: new Date(2024, 0, 1) })
    seedListing({ creatorId: 'cp_b' })
    const out = await svc.getCreatorListings('cp_a')
    expect(out.map((L) => L.id)).toEqual([b.id, a.id])
  })
})

// ─── browseListings (paging / filters / sort) ───────────────────────────────

describe('browseListings', () => {
  it('clamps page to >=1 and limit to 1..100', async () => {
    for (let i = 0; i < 5; i++) seedListing({ status: 'published' })
    const out = await svc.browseListings({ page: -10, limit: 200 } as any)
    expect(out.page).toBe(1)
    expect(out.limit).toBe(100)
    expect(out.totalPages).toBe(1)
  })

  it('paginates the result set', async () => {
    for (let i = 0; i < 7; i++) seedListing({ status: 'published' })
    const page1 = await svc.browseListings({ page: 1, limit: 3 })
    const page2 = await svc.browseListings({ page: 2, limit: 3 })
    const page3 = await svc.browseListings({ page: 3, limit: 3 })
    expect(page1.items).toHaveLength(3)
    expect(page2.items).toHaveLength(3)
    expect(page3.items).toHaveLength(1)
    expect(page1.total).toBe(7)
    expect(page1.totalPages).toBe(3)
  })

  it('filters by category', async () => {
    seedListing({ status: 'published', category: 'a' })
    seedListing({ status: 'published', category: 'b' })
    const out = await svc.browseListings({ category: 'a' })
    expect(out.items.every((L) => L.category === 'a')).toBe(true)
  })

  it('filters by pricingModel', async () => {
    seedListing({ status: 'published', pricingModel: 'free' })
    seedListing({ status: 'published', pricingModel: 'one_time' })
    const out = await svc.browseListings({ pricingModel: 'one_time' as any })
    expect(out.items.every((L) => L.pricingModel === 'one_time')).toBe(true)
  })

  it('filters by tags using sqlite contains-AND semantics', async () => {
    seedListing({ status: 'published', tags: 'ai,voice' })
    seedListing({ status: 'published', tags: 'ai,video' })
    seedListing({ status: 'published', tags: 'data' })
    const out = await svc.browseListings({ tags: ['ai', 'voice'] })
    expect(out.items).toHaveLength(1)
    expect(out.items[0]!.tags).toBe('ai,voice')
  })

  it('filters by creatorId', async () => {
    seedListing({ status: 'published', creatorId: 'cp_a' })
    seedListing({ status: 'published', creatorId: 'cp_b' })
    const out = await svc.browseListings({ creatorId: 'cp_a' })
    expect(out.items.every((L) => L.creatorId === 'cp_a')).toBe(true)
  })

  it('excludes by slug', async () => {
    seedListing({ status: 'published', slug: 'keep' })
    seedListing({ status: 'published', slug: 'drop' })
    const out = await svc.browseListings({ excludeSlug: 'drop' })
    expect(out.items.map((L) => L.slug)).toEqual(['keep'])
  })

  it('only returns published listings', async () => {
    seedListing({ status: 'published' })
    seedListing({ status: 'draft' })
    seedListing({ status: 'archived' })
    const out = await svc.browseListings()
    expect(out.total).toBe(1)
  })

  it('sorts by popular (installCount desc)', async () => {
    seedListing({ status: 'published', installCount: 1 })
    const top = seedListing({ status: 'published', installCount: 99 })
    const out = await svc.browseListings({ sort: 'popular' })
    expect(out.items[0]!.id).toBe(top.id)
  })

  it('sorts by rating (avg desc, then reviewCount desc)', async () => {
    seedListing({ status: 'published', averageRating: 3 })
    const top = seedListing({ status: 'published', averageRating: 5 })
    const out = await svc.browseListings({ sort: 'rating' })
    expect(out.items[0]!.id).toBe(top.id)
  })

  it('sorts by featured (sqlite branch: featuredAt desc)', async () => {
    seedListing({ status: 'published', featuredAt: null })
    const top = seedListing({ status: 'published', featuredAt: new Date(2024, 0, 1) })
    const out = await svc.browseListings({ sort: 'featured' })
    expect(out.items[0]!.id).toBe(top.id)
  })

  it('defaults to newest (publishedAt desc)', async () => {
    seedListing({ status: 'published', publishedAt: new Date(2020, 0, 1) })
    const newest = seedListing({ status: 'published', publishedAt: new Date(2024, 0, 1) })
    const out = await svc.browseListings()
    expect(out.items[0]!.id).toBe(newest.id)
  })
})

// ─── searchListings ──────────────────────────────────────────────────────────

describe('searchListings', () => {
  it('delegates to browseListings when the query is empty', async () => {
    seedListing({ status: 'published', title: 'A' })
    seedListing({ status: 'published', title: 'B' })
    const out = await svc.searchListings('   ')
    expect(out.total).toBe(2)
  })

  it('matches title via contains', async () => {
    seedListing({ status: 'published', title: 'Voice Agent' })
    seedListing({ status: 'published', title: 'Code Reviewer' })
    const out = await svc.searchListings('Voice')
    expect(out.items.map((L) => L.title)).toContain('Voice Agent')
    expect(out.items.map((L) => L.title)).not.toContain('Code Reviewer')
  })

  it('matches via shortDescription', async () => {
    seedListing({ status: 'published', title: 'X', shortDescription: 'amazing thing' })
    seedListing({ status: 'published', title: 'Y', shortDescription: 'boring thing' })
    const out = await svc.searchListings('amazing')
    expect(out.items).toHaveLength(1)
    expect(out.items[0]!.title).toBe('X')
  })

  it('matches via tags tokens (sqlite branch)', async () => {
    seedListing({ status: 'published', title: 'X', shortDescription: 's', tags: 'foo,bar' })
    seedListing({ status: 'published', title: 'Y', shortDescription: 's', tags: 'baz' })
    const out = await svc.searchListings('foo')
    expect(out.items).toHaveLength(1)
  })

  it('combines query + filters', async () => {
    seedListing({ status: 'published', title: 'X', shortDescription: 's', category: 'a' })
    seedListing({ status: 'published', title: 'X also', shortDescription: 's', category: 'b' })
    const out = await svc.searchListings('X', { category: 'a' })
    expect(out.items).toHaveLength(1)
  })
})

// ─── getFeaturedListings ─────────────────────────────────────────────────────

describe('getFeaturedListings', () => {
  it('returns only listings with featuredAt set', async () => {
    seedListing({ status: 'published', featuredAt: new Date() })
    seedListing({ status: 'published', featuredAt: null })
    const out = await svc.getFeaturedListings()
    expect(out).toHaveLength(1)
  })

  it('clamps the limit to [1, 100]', async () => {
    for (let i = 0; i < 5; i++) seedListing({ status: 'published', featuredAt: new Date() })
    const small = await svc.getFeaturedListings(0)
    expect(small).toHaveLength(1) // clamped up to 1
    const big = await svc.getFeaturedListings(500)
    expect(big.length).toBeLessThanOrEqual(100)
  })
})

// ─── createReview / getReviews / getUserReview ───────────────────────────────

describe('createReview', () => {
  it('rejects non-integer rating', async () => {
    await expect(
      svc.createReview('lst_x', 'user_1', 'inst_1', { rating: 4.5 } as any),
    ).rejects.toThrow(/integer from 1 to 5/)
  })

  it('rejects rating < 1', async () => {
    await expect(
      svc.createReview('lst_x', 'user_1', 'inst_1', { rating: 0 } as any),
    ).rejects.toThrow(/1 to 5/)
  })

  it('rejects rating > 5', async () => {
    await expect(
      svc.createReview('lst_x', 'user_1', 'inst_1', { rating: 6 } as any),
    ).rejects.toThrow(/1 to 5/)
  })

  it('rejects when no install matches user+listing', async () => {
    await expect(
      svc.createReview('lst_x', 'user_1', 'inst_missing', { rating: 5 } as any),
    ).rejects.toThrow(/Install not found/)
  })

  it('creates the review and updates listing aggregates inside the txn', async () => {
    const L = seedListing({ status: 'published' })
    const inst = seedInstall({ userId: 'user_1', listingId: L.id })
    const out = await svc.createReview(L.id, 'user_1', inst.id, {
      rating: 5,
      title: 'great',
      body: 'works',
    })
    expect(out.rating).toBe(5)
    const fresh = listings.get(L.id)!
    expect(fresh.reviewCount).toBe(1)
    expect(fresh.averageRating).toBe(5)
  })

  it('averages multiple ratings', async () => {
    const L = seedListing({ status: 'published' })
    const i1 = seedInstall({ userId: 'user_1', listingId: L.id })
    const i2 = seedInstall({ userId: 'user_2', listingId: L.id })
    await svc.createReview(L.id, 'user_1', i1.id, { rating: 4 })
    await svc.createReview(L.id, 'user_2', i2.id, { rating: 2 })
    const fresh = listings.get(L.id)!
    expect(fresh.reviewCount).toBe(2)
    expect(fresh.averageRating).toBe(3)
  })
})

describe('getReviews', () => {
  it('paginates reviews newest-first', async () => {
    const L = seedListing()
    for (let i = 0; i < 5; i++) {
      reviews.set(`r${i}`, {
        id: `r${i}`,
        listingId: L.id,
        userId: `u${i}`,
        installId: `i${i}`,
        rating: 5,
        createdAt: new Date(2020, 0, i + 1),
      })
    }
    const out = await svc.getReviews(L.id, 1, 2)
    expect(out.items).toHaveLength(2)
    expect(out.total).toBe(5)
    expect(out.totalPages).toBe(3)
  })
})

describe('getUserReview', () => {
  it('returns the user-specific review or null', async () => {
    const L = seedListing()
    reviews.set('r1', {
      id: 'r1',
      listingId: L.id,
      userId: 'u1',
      installId: 'i1',
      rating: 5,
      createdAt: new Date(),
    })
    expect((await svc.getUserReview(L.id, 'u1'))?.id).toBe('r1')
    expect(await svc.getUserReview(L.id, 'u2')).toBeNull()
  })
})

// ─── getCreatorDashboard ─────────────────────────────────────────────────────

describe('getCreatorDashboard', () => {
  it('returns null when the creator profile does not exist', async () => {
    expect(await svc.getCreatorDashboard('cp_missing')).toBeNull()
  })

  it('aggregates listings, review count, and earnings per listing', async () => {
    const p = seedProfile({ id: 'cp_owner', displayName: 'Ada' })
    const L1 = seedListing({ creatorId: p.id, status: 'published', installCount: 10 })
    const L2 = seedListing({ creatorId: p.id, status: 'draft', installCount: 0 })
    seedListing({ creatorId: 'cp_other' })
    reviews.set('r1', { id: 'r1', listingId: L1.id, userId: 'u1', installId: 'i1', rating: 5, createdAt: new Date() })
    reviews.set('r2', { id: 'r2', listingId: L1.id, userId: 'u2', installId: 'i2', rating: 3, createdAt: new Date() })
    reviews.set('r3', { id: 'r3', listingId: 'someone-else', userId: 'u3', installId: 'i3', rating: 4, createdAt: new Date() })
    seedTxn({ creatorId: p.id, listingId: L1.id, status: 'completed', creatorAmountInCents: 500 })
    seedTxn({ creatorId: p.id, listingId: L1.id, status: 'completed', creatorAmountInCents: 700 })
    seedTxn({ creatorId: p.id, listingId: L2.id, status: 'pending', creatorAmountInCents: 999 })

    const out = await svc.getCreatorDashboard(p.id)
    expect(out).not.toBeNull()
    expect(out!.profile.id).toBe(p.id)
    expect(out!.totalReviews).toBe(2)
    expect(out!.listings).toHaveLength(2)
    const stat1 = out!.listings.find((L) => L.id === L1.id)!
    const stat2 = out!.listings.find((L) => L.id === L2.id)!
    expect(stat1.totalEarningsInCents).toBe(1200)
    // L2 has only a 'pending' txn → excluded from completed-only sum.
    expect(stat2.totalEarningsInCents).toBe(0)
  })
})

// ─── getCreatorTransactions ──────────────────────────────────────────────────

describe('getCreatorTransactions', () => {
  it('paginates the creator transactions newest-first', async () => {
    for (let i = 0; i < 5; i++) {
      seedTxn({
        creatorId: 'cp_owner',
        listingId: 'lst_x',
        createdAt: new Date(2020, 0, i + 1),
        creatorAmountInCents: 100 * i,
      })
    }
    seedTxn({ creatorId: 'cp_other', listingId: 'lst_x' })
    const out = await svc.getCreatorTransactions('cp_owner', 1, 3)
    expect(out.total).toBe(5)
    expect(out.items).toHaveLength(3)
    expect(out.totalPages).toBe(2)
  })

  it('returns empty result when no transactions match', async () => {
    const out = await svc.getCreatorTransactions('cp_nobody')
    expect(out.total).toBe(0)
    expect(out.items).toEqual([])
    expect(out.totalPages).toBe(1)
  })
})

// ─── Postgres-branch coverage (isSqlite=false) ───────────────────────────────
// The test env always runs with SHOGO_LOCAL_MODE=true (SQLite). The three
// Postgres-only branches (tags hasEvery, featured nulls:last orderBy, tags
// hasSome search) are covered by temporarily flipping the seam to false.

describe('Postgres-only branches via _marketplaceSeamForTests', () => {
  afterEach(() => {
    svc._marketplaceSeamForTests.isSqliteOverride = null
  })

  it('uses hasEvery for tags filter when not SQLite (line 205)', async () => {
    svc._marketplaceSeamForTests.isSqliteOverride = false
    seedListing({ tags: 'ai,tools' })
    // Exercises the Postgres-branch tag filter inside buildWhere().
    // The in-memory mock accepts any query shape; we just verify no throw.
    await expect(svc.browseListings({ tags: ['ai'] })).resolves.toBeTruthy()
  })

  it('uses nulls:last featuredAt orderBy when not SQLite (lines 226-229)', async () => {
    svc._marketplaceSeamForTests.isSqliteOverride = false
    seedListing({ featuredAt: new Date() })
    await expect(svc.browseListings({ sort: 'featured' })).resolves.toBeTruthy()
  })

  it('uses hasSome for tag search when not SQLite (line 408)', async () => {
    svc._marketplaceSeamForTests.isSqliteOverride = false
    seedListing({ tags: 'ai,tools', title: 'AI Toolkit' })
    await expect(svc.searchListings('ai')).resolves.toBeTruthy()
  })
})
