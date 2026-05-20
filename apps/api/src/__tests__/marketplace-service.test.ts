// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/services/marketplace.service.ts`.
 *
 * Covers a representative subset across all major surfaces:
 *   - generateSlug (kebab + collision suffix + give-up)
 *   - createCreatorProfile, getCreatorProfile, getCreatorProfileById,
 *     updateCreatorProfile (CRUD pass-through)
 *   - createListing (slug auto-assigned, status='draft', undefined fields stripped)
 *   - updateListing / publishListing / unpublishListing (ownership + state machine)
 *   - getListingBySlug, getListingById, getCreatorListings
 *   - browseListings (filters + pagination + ordering)
 *   - searchListings (empty query delegates, token splitting, sqlite contains path)
 *   - getFeaturedListings (limit clamping, featured filter)
 *   - createReview (rating validation, install ownership, aggregate update)
 *   - getReviews, getUserReview (pagination + composite key)
 *   - getCreatorDashboard (404 + listings join)
 *   - getCreatorTransactions
 *
 * Prisma is replaced with a per-table in-memory stub keyed off `where`.
 * `nanoid` is stubbed so slug suffixes are deterministic.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { PRISMA_NAMESPACE, withPrismaExports } from './helpers/prisma-mock-exports'

// ─── In-memory state ──────────────────────────────────────────────────

let profiles: any[]
let listings: any[]
let reviews: any[]
let installs: any[]
let transactions: any[]

let nanoIdSeed = 0
function reset() {
  profiles = []
  listings = []
  reviews = []
  installs = []
  transactions = []
  nanoIdSeed = 0
}
reset()

mock.module('nanoid', () => ({
  customAlphabet: () => () => {
    nanoIdSeed += 1
    return `xy${nanoIdSeed.toString().padStart(4, '0')}`
  },
  nanoid: () => 'fixed',
}))

// ─── Prisma table stubs ──────────────────────────────────────────────

function matchWhere(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue
    if (k === 'OR' && Array.isArray(v)) {
      if (!v.some((w: any) => matchWhere(row, w))) return false
      continue
    }
    if (k === 'AND' && Array.isArray(v)) {
      if (!v.every((w: any) => matchWhere(row, w))) return false
      continue
    }
    if (v && typeof v === 'object') {
      if ('not' in v) {
        if (row[k] === v.not) return false
        continue
      }
      if ('contains' in v) {
        if (typeof row[k] !== 'string' || !row[k].toLowerCase().includes((v as any).contains.toLowerCase())) {
          return false
        }
        continue
      }
      if ('in' in v) {
        if (!(v as any).in.includes(row[k])) return false
        continue
      }
      if (k === 'listingId_userId') {
        if (row.listingId !== (v as any).listingId || row.userId !== (v as any).userId) return false
        continue
      }
      if ('creatorId' in v && k === 'listing') {
        // for review-by-creator path: row.listing.creatorId == v.creatorId
        const targetListing = listings.find((l) => l.id === row.listingId)
        if (!targetListing || targetListing.creatorId !== (v as any).creatorId) return false
        continue
      }
    }
    if (row[k] !== v) return false
  }
  return true
}

const profileTable = {
  create: async (args: any) => {
    const row = { id: `cp_${profiles.length + 1}`, createdAt: new Date(), ...args.data }
    profiles.push(row)
    return row
  },
  findUnique: async (args: any) =>
    profiles.find((p) => matchWhere(p, args.where)) ?? null,
  update: async (args: any) => {
    const r = profiles.find((p) => matchWhere(p, args.where))
    if (!r) throw new Error('not found')
    Object.assign(r, args.data)
    return r
  },
}

const listingTable = {
  create: async (args: any) => {
    const row = {
      id: `lst_${listings.length + 1}`,
      averageRating: 0,
      reviewCount: 0,
      installCount: 0,
      featuredAt: null,
      publishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...args.data,
    }
    listings.push(row)
    return row
  },
  findUnique: async (args: any) => listings.find((l) => matchWhere(l, args.where)) ?? null,
  findFirst: async (args: any) => {
    const found = listings.find((l) => matchWhere(l, args.where))
    if (!found) return null
    if (args.include?.creator) {
      return { ...found, creator: profiles.find((p) => p.id === found.creatorId) ?? null }
    }
    return found
  },
  findMany: async (args: any) => {
    let rows = listings.filter((l) => matchWhere(l, args.where ?? {}))
    if (args.orderBy) {
      const orderBy = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]
      rows = rows.slice().sort((a, b) => {
        for (const ob of orderBy) {
          const [k, dir] = Object.entries(ob)[0] as [string, any]
          const av = a[k] ?? 0
          const bv = b[k] ?? 0
          if (av === bv) continue
          return (av < bv ? -1 : 1) * (dir === 'desc' ? -1 : 1)
        }
        return 0
      })
    }
    if (args.skip) rows = rows.slice(args.skip)
    if (args.take) rows = rows.slice(0, args.take)
    return rows
  },
  count: async (args: any) =>
    listings.filter((l) => matchWhere(l, args?.where ?? {})).length,
  update: async (args: any) => {
    const r = listings.find((l) => matchWhere(l, args.where))
    if (!r) throw new Error('not found')
    Object.assign(r, args.data, { updatedAt: new Date() })
    return r
  },
}

const reviewTable = {
  create: async (args: any) => {
    const row = { id: `rev_${reviews.length + 1}`, createdAt: new Date(), ...args.data }
    reviews.push(row)
    return row
  },
  findUnique: async (args: any) => reviews.find((r) => matchWhere(r, args.where)) ?? null,
  findMany: async (args: any) => {
    let rows = reviews.filter((r) => matchWhere(r, args.where ?? {}))
    rows.sort((a, b) => b.createdAt - a.createdAt)
    if (args.skip) rows = rows.slice(args.skip)
    if (args.take) rows = rows.slice(0, args.take)
    return rows
  },
  count: async (args: any) =>
    reviews.filter((r) => matchWhere(r, args?.where ?? {})).length,
  aggregate: async (args: any) => {
    const rows = reviews.filter((r) => matchWhere(r, args.where))
    const sum = rows.reduce((s, r) => s + r.rating, 0)
    return {
      _avg: { rating: rows.length ? sum / rows.length : null },
      _count: { _all: rows.length },
    }
  },
}

const installTable = {
  findFirst: async (args: any) =>
    installs.find((i) => matchWhere(i, args.where)) ?? null,
}

const txnTable = {
  findMany: async (args: any) => {
    let rows = transactions.filter((t) => matchWhere(t, args.where ?? {}))
    if (args.skip) rows = rows.slice(args.skip)
    if (args.take) rows = rows.slice(0, args.take)
    return rows
  },
  count: async (args: any) =>
    transactions.filter((t) => matchWhere(t, args?.where ?? {})).length,
  groupBy: async (args: any) => {
    const grouped = new Map<string, number>()
    for (const t of transactions.filter((t) => matchWhere(t, args.where))) {
      grouped.set(
        t.listingId,
        (grouped.get(t.listingId) ?? 0) + (t.creatorAmountInCents ?? 0),
      )
    }
    return Array.from(grouped.entries()).map(([listingId, sum]) => ({
      listingId,
      _sum: { creatorAmountInCents: sum },
    }))
  },
}

const prismaStub: any = {
  creatorProfile: profileTable,
  marketplaceListing: listingTable,
  marketplaceReview: reviewTable,
  marketplaceInstall: installTable,
  marketplaceTransaction: txnTable,
  $transaction: async (fn: any) => {
    if (typeof fn === 'function') {
      return fn({
        marketplaceReview: reviewTable,
        marketplaceListing: listingTable,
      })
    }
    return Promise.all(fn)
  },
}

mock.module('../lib/prisma', () =>
  withPrismaExports({ prisma: prismaStub, Prisma: PRISMA_NAMESPACE }),
)

process.env.SHOGO_LOCAL_MODE = 'true' // exercise the sqlite-flavored branches
const svc = await import('../services/marketplace.service')

beforeEach(() => {
  reset()
})

// ──────────────────────────────────────────────────────────────────────
// generateSlug
// ──────────────────────────────────────────────────────────────────────

describe('generateSlug', () => {
  test('kebab-cases title and returns when free', async () => {
    expect(await svc.generateSlug('Hello World!')).toBe('hello-world')
  })

  test('appends nanoid suffix on collision', async () => {
    listings.push({ id: 'l1', slug: 'taken' })
    const out = await svc.generateSlug('TAKEN')
    expect(out).toMatch(/^taken-xy/)
  })

  test('returns "listing" fallback when title is all stripped', async () => {
    expect(await svc.generateSlug('!!!')).toBe('listing')
  })

  test('underscores are stripped and multiple spaces collapse to a single dash', async () => {
    // The first replace drops underscores entirely (not in [letters|numbers|space|dash]),
    // then [\s_]+ collapses runs of whitespace into single dashes.
    expect(await svc.generateSlug('foo___bar  baz')).toBe('foobar-baz')
  })

  test('preserves unicode letters via \\p{L}', async () => {
    expect(await svc.generateSlug('Café Latte')).toBe('café-latte')
  })
})

// ──────────────────────────────────────────────────────────────────────
// creator profile CRUD
// ──────────────────────────────────────────────────────────────────────

describe('creator profile CRUD', () => {
  test('createCreatorProfile sets userId from arg', async () => {
    const out = await svc.createCreatorProfile('u1', { displayName: 'X' } as any)
    expect(out.userId).toBe('u1')
    expect(out.displayName).toBe('X')
  })

  test('getCreatorProfile resolves by userId', async () => {
    profiles.push({ id: 'cp1', userId: 'u1', displayName: 'X' })
    expect((await svc.getCreatorProfile('u1'))?.id).toBe('cp1')
    expect(await svc.getCreatorProfile('ghost')).toBeNull()
  })

  test('getCreatorProfileById resolves by id', async () => {
    profiles.push({ id: 'cp1', userId: 'u1' })
    expect((await svc.getCreatorProfileById('cp1'))?.userId).toBe('u1')
    expect(await svc.getCreatorProfileById('ghost')).toBeNull()
  })

  test('updateCreatorProfile merges fields', async () => {
    profiles.push({ id: 'cp1', userId: 'u1', displayName: 'old' })
    const out = await svc.updateCreatorProfile('u1', { displayName: 'new' } as any)
    expect(out.displayName).toBe('new')
  })
})

// ──────────────────────────────────────────────────────────────────────
// listing CRUD + state machine
// ──────────────────────────────────────────────────────────────────────

describe('listing CRUD + state machine', () => {
  test('createListing assigns slug + status="draft"', async () => {
    const out = await svc.createListing('cp1', 'proj1', {
      title: 'Cool Agent',
      shortDescription: 'short',
    } as any)
    expect(out.slug).toBe('cool-agent')
    expect(out.status).toBe('draft')
    expect(out.creatorId).toBe('cp1')
    expect(out.projectId).toBe('proj1')
  })

  test('updateListing throws when listing not owned', async () => {
    listings.push({ id: 'l1', creatorId: 'cp_other', status: 'draft' })
    await expect(svc.updateListing('l1', 'cp_me', { title: 'x' } as any)).rejects.toThrow(
      'Listing not found or not owned by this creator',
    )
  })

  test('updateListing happy path', async () => {
    listings.push({ id: 'l1', creatorId: 'cp1', status: 'draft', title: 'old' })
    const out = await svc.updateListing('l1', 'cp1', { title: 'new' } as any)
    expect(out.title).toBe('new')
  })

  test('publishListing rejects non-draft listings', async () => {
    listings.push({ id: 'l1', creatorId: 'cp1', status: 'published' })
    await expect(svc.publishListing('l1', 'cp1')).rejects.toThrow(
      'Only draft or in-review listings can be published',
    )
  })

  test('publishListing rejects unowned', async () => {
    listings.push({ id: 'l1', creatorId: 'cp_other', status: 'draft' })
    await expect(svc.publishListing('l1', 'cp_me')).rejects.toThrow(
      'Listing not found or not owned by this creator',
    )
  })

  test('publishListing sets status=published and publishedAt', async () => {
    listings.push({ id: 'l1', creatorId: 'cp1', status: 'draft', publishedAt: null })
    const out = await svc.publishListing('l1', 'cp1')
    expect(out.status).toBe('published')
    expect(out.publishedAt).toBeInstanceOf(Date)
  })

  test('publishListing allows in_review → published', async () => {
    listings.push({ id: 'l1', creatorId: 'cp1', status: 'in_review' })
    const out = await svc.publishListing('l1', 'cp1')
    expect(out.status).toBe('published')
  })

  test('unpublishListing → status=archived', async () => {
    listings.push({ id: 'l1', creatorId: 'cp1', status: 'published' })
    const out = await svc.unpublishListing('l1', 'cp1')
    expect(out.status).toBe('archived')
  })

  test('unpublishListing rejects unowned', async () => {
    listings.push({ id: 'l1', creatorId: 'cp_other', status: 'published' })
    await expect(svc.unpublishListing('l1', 'cp_me')).rejects.toThrow()
  })
})

// ──────────────────────────────────────────────────────────────────────
// listing readers
// ──────────────────────────────────────────────────────────────────────

describe('listing readers', () => {
  test('getListingBySlug only returns published rows', async () => {
    listings.push(
      { id: 'l1', slug: 'a', status: 'draft', creatorId: 'cp1' },
      { id: 'l2', slug: 'b', status: 'published', creatorId: 'cp1' },
    )
    profiles.push({ id: 'cp1', userId: 'u1' })
    expect(await svc.getListingBySlug('a')).toBeNull()
    const found = await svc.getListingBySlug('b')
    expect(found?.id).toBe('l2')
    expect((found as any).creator?.id).toBe('cp1')
  })

  test('getListingById returns regardless of status', async () => {
    listings.push({ id: 'l1', slug: 'a', status: 'draft' })
    expect((await svc.getListingById('l1'))?.id).toBe('l1')
  })

  test('getCreatorListings filters by creator', async () => {
    listings.push(
      { id: 'l1', creatorId: 'cp1' },
      { id: 'l2', creatorId: 'cp2' },
      { id: 'l3', creatorId: 'cp1' },
    )
    const out = await svc.getCreatorListings('cp1')
    expect(out.map((l) => l.id).sort()).toEqual(['l1', 'l3'])
  })
})

// ──────────────────────────────────────────────────────────────────────
// browseListings
// ──────────────────────────────────────────────────────────────────────

describe('browseListings', () => {
  beforeEach(() => {
    for (let i = 1; i <= 30; i++) {
      listings.push({
        id: `l${i}`,
        slug: `s${i}`,
        title: `T${i}`,
        status: i % 5 === 0 ? 'draft' : 'published',
        category: i % 2 === 0 ? 'productivity' : 'biz',
        creatorId: `cp${i}`,
        installCount: i,
        averageRating: 5 - (i % 5),
        publishedAt: new Date(2025, 0, i),
        featuredAt: null,
        reviewCount: i,
      })
    }
  })

  test('defaults: page 1, limit 20, only published', async () => {
    const out = await svc.browseListings({})
    expect(out.page).toBe(1)
    expect(out.limit).toBe(20)
    expect(out.total).toBe(24) // 30 - 6 drafts
    expect(out.items).toHaveLength(20)
    expect(out.items.every((l) => l.status === 'published')).toBe(true)
  })

  test('clamps page<1 → 1 and limit>100 → 100', async () => {
    const out = await svc.browseListings({ page: -5, limit: 999 })
    expect(out.page).toBe(1)
    expect(out.limit).toBe(100)
  })

  test('category filter is applied', async () => {
    const out = await svc.browseListings({ category: 'productivity', limit: 100 })
    expect(out.items.every((l) => l.category === 'productivity')).toBe(true)
  })

  test('excludeSlug skips matching row', async () => {
    const out = await svc.browseListings({ excludeSlug: 's3', limit: 100 })
    expect(out.items.find((l) => l.slug === 's3')).toBeUndefined()
  })

  test('sort=popular orders by installCount desc', async () => {
    const out = await svc.browseListings({ sort: 'popular' })
    expect(out.items[0].installCount).toBeGreaterThanOrEqual(out.items[1].installCount)
  })

  test('totalPages is 1 when total=0', async () => {
    listings.length = 0
    const out = await svc.browseListings({})
    expect(out.totalPages).toBe(1)
  })
})

// ──────────────────────────────────────────────────────────────────────
// searchListings
// ──────────────────────────────────────────────────────────────────────

describe('searchListings', () => {
  test('empty query delegates to browseListings', async () => {
    listings.push({
      id: 'l1', slug: 's1', title: 'X', status: 'published',
      category: 'biz', publishedAt: new Date(), featuredAt: null,
      averageRating: 0, reviewCount: 0, installCount: 0, creatorId: 'cp1',
    })
    const out = await svc.searchListings('   ')
    expect(out.total).toBe(1)
  })

  test('matches against title (case-insensitive via sqlite contains)', async () => {
    listings.push({
      id: 'l1', slug: 's1', title: 'Slack Bot', shortDescription: 'sd',
      status: 'published', publishedAt: new Date(), averageRating: 0, reviewCount: 0,
      installCount: 0, creatorId: 'cp1', featuredAt: null,
    })
    listings.push({
      id: 'l2', slug: 's2', title: 'Calendar', shortDescription: 'sd',
      status: 'published', publishedAt: new Date(), averageRating: 0, reviewCount: 0,
      installCount: 0, creatorId: 'cp1', featuredAt: null,
    })
    const out = await svc.searchListings('slack')
    expect(out.items.map((l) => l.id)).toContain('l1')
  })
})

// ──────────────────────────────────────────────────────────────────────
// getFeaturedListings
// ──────────────────────────────────────────────────────────────────────

describe('getFeaturedListings', () => {
  test('clamps limit between 1 and 100', async () => {
    for (let i = 0; i < 5; i++) {
      listings.push({
        id: `f${i}`, status: 'published', featuredAt: new Date(2025, 0, i + 1),
        publishedAt: new Date(), slug: `s${i}`,
      })
    }
    const out = await svc.getFeaturedListings(2)
    expect(out).toHaveLength(2)
  })

  test('omits non-featured rows', async () => {
    listings.push({ id: 'f1', status: 'published', featuredAt: null, publishedAt: new Date() })
    expect(await svc.getFeaturedListings(10)).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────────────────────────
// createReview + getReviews + getUserReview
// ──────────────────────────────────────────────────────────────────────

describe('reviews', () => {
  test('createReview rejects rating out of range', async () => {
    await expect(svc.createReview('l1', 'u1', 'i1', { rating: 0 } as any)).rejects.toThrow(
      'Rating must be an integer from 1 to 5',
    )
    await expect(svc.createReview('l1', 'u1', 'i1', { rating: 6 } as any)).rejects.toThrow()
    await expect(svc.createReview('l1', 'u1', 'i1', { rating: 3.5 } as any)).rejects.toThrow()
  })

  test('createReview rejects when install does not match', async () => {
    await expect(svc.createReview('l1', 'u1', 'i_ghost', { rating: 5 } as any)).rejects.toThrow(
      'Install not found',
    )
  })

  test('createReview creates row + updates listing aggregate', async () => {
    listings.push({ id: 'l1', averageRating: 0, reviewCount: 0 })
    installs.push({ id: 'i1', listingId: 'l1', userId: 'u1' })
    const out = await svc.createReview('l1', 'u1', 'i1', { rating: 5 } as any)
    expect(out.rating).toBe(5)
    const listing = listings.find((l) => l.id === 'l1')!
    expect(listing.averageRating).toBe(5)
    expect(listing.reviewCount).toBe(1)
  })

  test('getReviews paginates by listingId', async () => {
    for (let i = 0; i < 25; i++) {
      reviews.push({
        id: `r${i}`, listingId: 'l1', userId: `u${i}`, rating: 5,
        createdAt: new Date(2025, 0, i + 1),
      })
    }
    const out = await svc.getReviews('l1', 1, 10)
    expect(out.total).toBe(25)
    expect(out.items).toHaveLength(10)
    expect(out.totalPages).toBe(3)
  })

  test('getUserReview uses composite key', async () => {
    reviews.push({ id: 'r1', listingId: 'l1', userId: 'u1', rating: 4 })
    const found = await svc.getUserReview('l1', 'u1')
    expect(found?.id).toBe('r1')
    expect(await svc.getUserReview('l1', 'ghost')).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────
// getCreatorDashboard
// ──────────────────────────────────────────────────────────────────────

describe('getCreatorDashboard', () => {
  test('returns null when creator missing', async () => {
    expect(await svc.getCreatorDashboard('ghost')).toBeNull()
  })

  test('joins listings + review totals + earnings', async () => {
    profiles.push({ id: 'cp1', userId: 'u1', displayName: 'X' })
    listings.push(
      { id: 'l1', slug: 's1', title: 'A', status: 'published', creatorId: 'cp1', installCount: 3, averageRating: 4, reviewCount: 2 },
      { id: 'l2', slug: 's2', title: 'B', status: 'draft',     creatorId: 'cp1', installCount: 0, averageRating: 0, reviewCount: 0 },
    )
    reviews.push({ id: 'r1', listingId: 'l1', userId: 'u1', rating: 5 })
    transactions.push({
      id: 't1', creatorId: 'cp1', listingId: 'l1', status: 'completed', creatorAmountInCents: 250,
    })
    transactions.push({
      id: 't2', creatorId: 'cp1', listingId: 'l1', status: 'completed', creatorAmountInCents: 750,
    })
    const out = await svc.getCreatorDashboard('cp1')
    expect(out?.totalReviews).toBe(1)
    expect(out?.listings).toHaveLength(2)
    const l1 = out!.listings.find((l) => l.id === 'l1')!
    expect(l1.totalEarningsInCents).toBe(1000)
    const l2 = out!.listings.find((l) => l.id === 'l2')!
    expect(l2.totalEarningsInCents).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────
// getCreatorTransactions
// ──────────────────────────────────────────────────────────────────────

describe('getCreatorTransactions', () => {
  test('paginates by creatorId', async () => {
    for (let i = 0; i < 8; i++) {
      transactions.push({
        id: `t${i}`, creatorId: 'cp1', createdAt: new Date(),
      })
    }
    transactions.push({ id: 'tX', creatorId: 'cp2', createdAt: new Date() })
    const out = await svc.getCreatorTransactions('cp1', 1, 5)
    expect(out.total).toBe(8)
    expect(out.items).toHaveLength(5)
    expect(out.totalPages).toBe(2)
  })
})

// ─── Coverage gap-closers ──────────────────────────────────────────────────

describe('browseListings — filter coverage', () => {
  test('pricingModel filter is applied (line 191)', async () => {
    listings.length = 0
    listings.push(
      { id: 'p1', status: 'published', pricingModel: 'free' },
      { id: 'p2', status: 'published', pricingModel: 'paid' },
    )
    const out = await svc.browseListings({ pricingModel: 'paid', limit: 100 })
    expect(out.items.every((l: any) => l.pricingModel === 'paid')).toBe(true)
  })

  test('creatorId filter is applied (line 201)', async () => {
    listings.length = 0
    listings.push(
      { id: 'c1', status: 'published', creatorId: 'creator-a' },
      { id: 'c2', status: 'published', creatorId: 'creator-b' },
    )
    const out = await svc.browseListings({ creatorId: 'creator-b', limit: 100 })
    expect(out.items.map((l: any) => l.id)).toEqual(['c2'])
  })

  test('tags filter — sqlite branch uses contains AND-chain (lines 194-195)', async () => {
    listings.length = 0
    listings.push(
      { id: 't1', status: 'published', tags: 'foo,bar,baz' },
      { id: 't2', status: 'published', tags: 'qux' },
    )
    const out = await svc.browseListings({ tags: ['foo', 'bar'], limit: 100 })
    expect(out.items.map((l: any) => l.id)).toEqual(['t1'])
  })

  test('tags filter — postgres branch uses hasEvery (lines 196-197)', async () => {
    // Toggle isSqlite() to false by clearing the env. The lazy getter
    // re-reads on each call, so the postgres branch fires on this
    // browseListings call without re-importing the module.
    const orig = process.env.SHOGO_LOCAL_MODE
    delete process.env.SHOGO_LOCAL_MODE
    try {
      // Sniff the where filter via the mock so we can assert hasEvery shape.
      const seen: any[] = []
      const oldFindMany = listingTable.findMany
      listingTable.findMany = async (args: any) => {
        seen.push(args)
        return []
      }
      try {
        await svc.browseListings({ tags: ['x', 'y'], limit: 5 })
        expect(seen[0]?.where).toMatchObject({ tags: { hasEvery: ['x', 'y'] } })
      } finally {
        listingTable.findMany = oldFindMany
      }
    } finally {
      if (orig !== undefined) process.env.SHOGO_LOCAL_MODE = orig
    }
  })
})

describe('listingOrderBy — sort branches', () => {
  test('sort=rating orders by averageRating then reviewCount then publishedAt (lines 213-214)', async () => {
    const seen: any[] = []
    const oldFindMany = listingTable.findMany
    listingTable.findMany = async (args: any) => {
      seen.push(args)
      return []
    }
    try {
      await svc.browseListings({ sort: 'rating' })
      expect(seen[0]?.orderBy).toEqual([
        { averageRating: 'desc' },
        { reviewCount: 'desc' },
        { publishedAt: 'desc' },
      ])
    } finally {
      listingTable.findMany = oldFindMany
    }
  })

  test('sort=featured — sqlite branch (lines 215-218)', async () => {
    const seen: any[] = []
    const oldFindMany = listingTable.findMany
    listingTable.findMany = async (args: any) => {
      seen.push(args)
      return []
    }
    try {
      await svc.browseListings({ sort: 'featured' })
      // SHOGO_LOCAL_MODE='true' is set at module-load top of this file,
      // so the sqlite branch fires.
      expect(seen[0]?.orderBy).toEqual([
        { featuredAt: 'desc' },
        { publishedAt: 'desc' },
      ])
    } finally {
      listingTable.findMany = oldFindMany
    }
  })

  test('sort=featured — postgres branch with nulls:last (lines 219-221)', async () => {
    const orig = process.env.SHOGO_LOCAL_MODE
    delete process.env.SHOGO_LOCAL_MODE
    const seen: any[] = []
    const oldFindMany = listingTable.findMany
    listingTable.findMany = async (args: any) => {
      seen.push(args)
      return []
    }
    try {
      await svc.browseListings({ sort: 'featured' })
      expect(seen[0]?.orderBy).toEqual([
        { featuredAt: { sort: 'desc', nulls: 'last' } },
        { publishedAt: 'desc' },
      ])
    } finally {
      if (orig !== undefined) process.env.SHOGO_LOCAL_MODE = orig
      listingTable.findMany = oldFindMany
    }
  })
})

describe('searchListings — postgres tags branch (line 400)', () => {
  test('searchOr.push tags hasSome under non-sqlite mode', async () => {
    const orig = process.env.SHOGO_LOCAL_MODE
    delete process.env.SHOGO_LOCAL_MODE
    const seen: any[] = []
    const oldFindMany = listingTable.findMany
    const oldCount = listingTable.count
    listingTable.findMany = async (args: any) => {
      seen.push(args)
      return []
    }
    listingTable.count = async () => 0
    try {
      await svc.searchListings('foo bar')
      const orClause = seen[0]?.where?.OR ?? []
      // Look for the { tags: { hasSome: [...] } } shape contributed by L401.
      const found = orClause.find((o: any) =>
        o?.tags && Array.isArray(o.tags.hasSome),
      )
      expect(found).toBeDefined()
      expect(found.tags.hasSome).toEqual(['foo', 'bar'])
    } finally {
      if (orig !== undefined) process.env.SHOGO_LOCAL_MODE = orig
      listingTable.findMany = oldFindMany
      listingTable.count = oldCount
    }
  })
})

describe('generateSlug — collision exhausts retries', () => {
  test('throws after 32 failed attempts (lines 169-170)', async () => {
    // Pre-populate the listings fixture with 33 slugs that match every
    // suffix the deterministic nanoid stub will produce.
    const seedBase = nanoIdSeed
    listings.length = 0
    listings.push({ id: 'base', slug: 'taken' })
    for (let i = 0; i < 33; i++) {
      const suffix = `xy${(seedBase + i + 1).toString().padStart(4, '0')}`
      listings.push({ id: `id-${i}`, slug: `taken-${suffix}` })
    }
    await expect(svc.generateSlug('TAKEN')).rejects.toThrow(/unique listing slug/)
  })
})
