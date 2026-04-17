// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'

import { prisma } from '../lib/prisma'
import { authMiddleware, requireAuth } from '../middleware/auth'
import { requireSuperAdmin } from '../middleware/super-admin'
import * as stripeConnect from '../services/stripe-connect.service'

const ADMIN_LISTING_STATUSES = ['published', 'suspended', 'archived'] as const
type AdminListingStatus = (typeof ADMIN_LISTING_STATUSES)[number]

const ALL_LISTING_STATUSES = ['draft', 'in_review', 'published', 'suspended', 'archived'] as const
type AnyListingStatus = (typeof ALL_LISTING_STATUSES)[number]

function normalizePagination(page?: number, limit?: number): {
  page: number
  limit: number
  skip: number
} {
  const p = Math.max(1, page ?? 1)
  const l = Math.min(100, Math.max(1, limit ?? 20))
  return { page: p, limit: l, skip: (p - 1) * l }
}

function parseOptionalInt(v: string | null): number | undefined {
  if (v == null || v === '') return undefined
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

export function adminMarketplaceRoutes() {
  const app = new Hono()

  app.use('*', authMiddleware)
  app.use('*', requireAuth)
  app.use('*', requireSuperAdmin)

  app.get('/payouts/pending', async (c) => {
    const creators = await prisma.creatorProfile.findMany({
      where: { pendingPayoutInCents: { gt: 0 } },
      include: {
        user: { select: { email: true } },
      },
      orderBy: { pendingPayoutInCents: 'desc' },
    })

    const rows = await Promise.all(
      creators.map(async (cr) => {
        let stripeBalance: number | null = null
        if (cr.stripeCustomAccountId) {
          try {
            stripeBalance = await stripeConnect.getAccountBalance(cr.stripeCustomAccountId)
          } catch {
            stripeBalance = null
          }
        }
        return {
          creatorId: cr.id,
          displayName: cr.displayName,
          email: cr.user.email,
          pendingPayoutInCents: cr.pendingPayoutInCents,
          stripeBalance,
          payoutStatus: cr.payoutStatus,
          stripeCustomAccountId: cr.stripeCustomAccountId,
        }
      }),
    )

    return c.json({ ok: true, data: rows })
  })

  app.post('/payouts/release', async (c) => {
    let body: { creatorIds?: unknown; amountInCents?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'invalid_json', message: 'Invalid JSON body' } }, 400)
    }

    if (!Array.isArray(body.creatorIds) || body.creatorIds.some((id) => typeof id !== 'string')) {
      return c.json(
        { error: { code: 'invalid_body', message: 'creatorIds must be an array of strings' } },
        400,
      )
    }

    let amountOverride: number | undefined
    if (body.amountInCents !== undefined && body.amountInCents !== null) {
      if (typeof body.amountInCents !== 'number' || !Number.isFinite(body.amountInCents)) {
        return c.json(
          { error: { code: 'invalid_body', message: 'amountInCents must be a finite number when set' } },
          400,
        )
      }
      amountOverride = Math.floor(body.amountInCents)
      if (amountOverride <= 0) {
        return c.json(
          { error: { code: 'invalid_body', message: 'amountInCents must be positive when set' } },
          400,
        )
      }
    }

    const results: Array<{
      creatorId: string
      success: boolean
      payoutId?: string
      amountInCents?: number
      error?: string
    }> = []

    for (const creatorId of body.creatorIds as string[]) {
      const profile = await prisma.creatorProfile.findUnique({
        where: { id: creatorId },
      })

      if (!profile) {
        results.push({ creatorId, success: false, error: 'Creator not found' })
        continue
      }

      if (!profile.stripeCustomAccountId) {
        results.push({ creatorId, success: false, error: 'Creator has no Stripe Connect account' })
        continue
      }

      let available = 0
      try {
        available = await stripeConnect.getAccountBalance(profile.stripeCustomAccountId)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Failed to read Stripe balance'
        results.push({ creatorId, success: false, error: msg })
        continue
      }

      const amount = amountOverride === undefined ? available : amountOverride

      if (amount <= 0) {
        results.push({ creatorId, success: false, error: 'No amount available to payout' })
        continue
      }

      if (amount > available) {
        results.push({ creatorId, success: false, error: 'Requested payout exceeds available balance' })
        continue
      }

      let payoutId: string
      try {
        payoutId = await stripeConnect.triggerPayout(
          creatorId,
          amountOverride === undefined ? undefined : amount,
        )
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Payout failed'
        results.push({ creatorId, success: false, error: msg })
        continue
      }

      const newPending = Math.max(0, profile.pendingPayoutInCents - amount)

      const anchorListing = await prisma.marketplaceListing.findFirst({
        where: { creatorId },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })

      try {
        await prisma.$transaction(async (tx) => {
          await tx.creatorProfile.update({
            where: { id: creatorId },
            data: {
              pendingPayoutInCents: newPending,
              totalPaidOutInCents: profile.totalPaidOutInCents + amount,
            },
          })

          if (anchorListing) {
            await tx.marketplaceTransaction.create({
              data: {
                listingId: anchorListing.id,
                buyerUserId: profile.userId,
                creatorId,
                type: 'refund',
                amountInCents: amount,
                platformFeeInCents: 0,
                creatorAmountInCents: amount,
                status: 'completed',
                stripeTransferId: payoutId,
              },
            })
          }
        })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Failed to update payout ledger'
        results.push({ creatorId, success: false, error: msg })
        continue
      }

      results.push({ creatorId, success: true, payoutId, amountInCents: amount })
    }

    return c.json({ ok: true, data: { results } })
  })

  app.post('/payouts/hold', async (c) => {
    let body: { creatorId?: unknown; reason?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'invalid_json', message: 'Invalid JSON body' } }, 400)
    }

    if (typeof body.creatorId !== 'string' || body.creatorId === '') {
      return c.json({ error: { code: 'invalid_body', message: 'creatorId is required' } }, 400)
    }
    if (typeof body.reason !== 'string' || body.reason.trim() === '') {
      return c.json({ error: { code: 'invalid_body', message: 'reason is required' } }, 400)
    }

    const updated = await prisma.creatorProfile.updateMany({
      where: { id: body.creatorId },
      data: { payoutStatus: 'disabled' },
    })

    if (updated.count === 0) {
      return c.json({ error: { code: 'not_found', message: 'Creator not found' } }, 404)
    }

    return c.json({ ok: true, data: { creatorId: body.creatorId, reason: body.reason } })
  })

  app.get('/payouts/history', async (c) => {
    const url = new URL(c.req.url)
    const { page, limit, skip } = normalizePagination(
      parseOptionalInt(url.searchParams.get('page')),
      parseOptionalInt(url.searchParams.get('limit')),
    )
    const creatorId = url.searchParams.get('creatorId')?.trim() || undefined

    const where = creatorId ? { creatorId } : {}

    const [items, total] = await Promise.all([
      prisma.marketplaceTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          listing: {
            select: {
              id: true,
              slug: true,
              title: true,
              status: true,
              pricingModel: true,
            },
          },
          creator: {
            include: {
              user: { select: { id: true, email: true, name: true } },
            },
          },
        },
      }),
      prisma.marketplaceTransaction.count({ where }),
    ])

    const totalPages = Math.ceil(total / limit) || 1

    return c.json({
      ok: true,
      data: { items, total, page, limit, totalPages },
    })
  })

  app.get('/listings', async (c) => {
    const url = new URL(c.req.url)
    const { page, limit, skip } = normalizePagination(
      parseOptionalInt(url.searchParams.get('page')),
      parseOptionalInt(url.searchParams.get('limit')),
    )
    const statusRaw = url.searchParams.get('status')?.trim()

    const where: { status?: AnyListingStatus } =
      statusRaw && (ALL_LISTING_STATUSES as readonly string[]).includes(statusRaw)
        ? { status: statusRaw as AnyListingStatus }
        : {}

    const [items, total] = await Promise.all([
      prisma.marketplaceListing.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
        include: {
          creator: {
            include: {
              user: { select: { id: true, email: true, name: true } },
            },
          },
        },
      }),
      prisma.marketplaceListing.count({ where }),
    ])

    const totalPages = Math.ceil(total / limit) || 1

    return c.json({
      ok: true,
      data: { items, total, page, limit, totalPages },
    })
  })

  app.patch('/listings/:id/status', async (c) => {
    const id = c.req.param('id')
    let body: { status?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'invalid_json', message: 'Invalid JSON body' } }, 400)
    }

    if (typeof body.status !== 'string' || !ADMIN_LISTING_STATUSES.includes(body.status as AdminListingStatus)) {
      return c.json(
        {
          error: {
            code: 'invalid_body',
            message: `status must be one of: ${ADMIN_LISTING_STATUSES.join(', ')}`,
          },
        },
        400,
      )
    }

    try {
      const listing = await prisma.marketplaceListing.update({
        where: { id },
        data: { status: body.status as AdminListingStatus },
        include: {
          creator: {
            include: {
              user: { select: { id: true, email: true, name: true } },
            },
          },
        },
      })
      return c.json({ ok: true, data: listing })
    } catch {
      return c.json({ error: { code: 'not_found', message: 'Listing not found' } }, 404)
    }
  })

  app.post('/listings/:id/feature', async (c) => {
    const id = c.req.param('id')

    const raw = await c.req.json().catch(() => ({}))
    const body =
      raw && typeof raw === 'object' ? (raw as { featuredAt?: unknown }) : {}

    let featuredAt: Date | null
    if (body.featuredAt === null) {
      featuredAt = null
    } else if (body.featuredAt === undefined) {
      featuredAt = new Date()
    } else if (typeof body.featuredAt === 'string') {
      const d = new Date(body.featuredAt)
      if (Number.isNaN(d.getTime())) {
        return c.json({ error: { code: 'invalid_body', message: 'featuredAt must be a valid ISO date string' } }, 400)
      }
      featuredAt = d
    } else {
      return c.json(
        { error: { code: 'invalid_body', message: 'featuredAt must be a string, null, or omitted' } },
        400,
      )
    }

    try {
      const listing = await prisma.marketplaceListing.update({
        where: { id },
        data: { featuredAt },
        include: {
          creator: {
            include: {
              user: { select: { id: true, email: true, name: true } },
            },
          },
        },
      })
      return c.json({ ok: true, data: listing })
    } catch {
      return c.json({ error: { code: 'not_found', message: 'Listing not found' } }, 404)
    }
  })

  return app
}
