// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma, PricingModel, type Prisma } from '../lib/prisma'
import type { AuthContext } from '../middleware/auth'
import * as marketplaceService from '../services/marketplace.service'
import * as installService from '../services/marketplace-install.service'
import * as stripeConnect from '../services/stripe-connect.service'
import * as gamification from '../services/creator-gamification.service'

const PRICING_MODELS = new Set<string>(['free', 'one_time', 'subscription'])
const LISTING_SORTS = new Set<string>(['popular', 'rating', 'newest', 'featured'])

function getFrontendUrl(): string {
  if (process.env.APP_URL) {
    return process.env.APP_URL
  }
  const allowed = process.env.ALLOWED_ORIGINS
  if (allowed) {
    const first = allowed.split(',')[0]?.trim()
    if (first) {
      return first
    }
  }
  const vite = parseInt(process.env.VITE_PORT || '3000', 10)
  return `http://localhost:${vite}`
}

function parseIntParam(v: string | undefined, fallback: number): number {
  if (v == null || v === '') return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

function parsePricingModel(v: string | undefined): PricingModel | undefined {
  if (v == null || v === '') return undefined
  return PRICING_MODELS.has(v) ? (v as PricingModel) : undefined
}

function parseSort(v: string | undefined): marketplaceService.ListingSort | undefined {
  if (v == null || v === '') return undefined
  return LISTING_SORTS.has(v) ? (v as marketplaceService.ListingSort) : undefined
}

function parseTags(v: string | undefined): string[] | undefined {
  if (v == null || v === '') return undefined
  const tags = v.split(',').map((s) => s.trim()).filter(Boolean)
  return tags.length > 0 ? tags : undefined
}

export function marketplaceRoutes() {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const category = c.req.query('category') || undefined
      const pricingModel = parsePricingModel(c.req.query('pricingModel') ?? undefined)
      const tags = parseTags(c.req.query('tags') ?? undefined)
      const sort = parseSort(c.req.query('sort') ?? undefined)
      const page = parseIntParam(c.req.query('page') ?? undefined, 1)
      const limit = parseIntParam(c.req.query('limit') ?? undefined, 20)
      const result = await marketplaceService.browseListings({
        category,
        pricingModel,
        tags,
        sort,
        page,
        limit,
      })
      return c.json(result)
    } catch (err) {
      console.error('[marketplace] browseListings', err)
      return c.json({ error: 'Failed to browse listings' }, 500)
    }
  })

  app.get('/featured', async (c) => {
    try {
      const limit = parseIntParam(c.req.query('limit') ?? undefined, 12)
      const items = await marketplaceService.getFeaturedListings(limit)
      return c.json({ items })
    } catch (err) {
      console.error('[marketplace] getFeaturedListings', err)
      return c.json({ error: 'Failed to load featured listings' }, 500)
    }
  })

  app.get('/search', async (c) => {
    try {
      const q = c.req.query('q') ?? ''
      const category = c.req.query('category') || undefined
      const pricingModel = parsePricingModel(c.req.query('pricingModel') ?? undefined)
      const sort = parseSort(c.req.query('sort') ?? undefined)
      const page = parseIntParam(c.req.query('page') ?? undefined, 1)
      const limit = parseIntParam(c.req.query('limit') ?? undefined, 20)
      const result = await marketplaceService.searchListings(q, {
        category,
        pricingModel,
        sort,
        page,
        limit,
      })
      return c.json(result)
    } catch (err) {
      console.error('[marketplace] searchListings', err)
      return c.json({ error: 'Search failed' }, 500)
    }
  })

  app.get('/creators/leaderboard', async (c) => {
    try {
      const page = parseIntParam(c.req.query('page') ?? undefined, 1)
      const limit = parseIntParam(c.req.query('limit') ?? undefined, 20)
      const result = await gamification.getLeaderboard(page, limit)
      return c.json(result)
    } catch (err) {
      console.error('[marketplace] getLeaderboard', err)
      return c.json({ error: 'Failed to load leaderboard' }, 500)
    }
  })

  app.get('/creators/:id/badges', async (c) => {
    try {
      const profile = await gamification.getCreatorPublicProfile(c.req.param('id'))
      if (!profile) {
        return c.json({ error: 'Creator not found' }, 404)
      }
      return c.json({ badges: profile.badges })
    } catch (err) {
      console.error('[marketplace] creator badges', err)
      return c.json({ error: 'Failed to load badges' }, 500)
    }
  })

  app.get('/creators/:id', async (c) => {
    try {
      const profile = await gamification.getCreatorPublicProfile(c.req.param('id'))
      if (!profile) {
        return c.json({ error: 'Creator not found' }, 404)
      }
      return c.json(profile)
    } catch (err) {
      console.error('[marketplace] getCreatorPublicProfile', err)
      return c.json({ error: 'Failed to load creator' }, 500)
    }
  })

  app.get('/my-installs', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const installs = await installService.getInstallsForUser(authCtx.userId)
      return c.json({ installs })
    } catch (err) {
      console.error('[marketplace] getInstallsForUser', err)
      return c.json({ error: 'Failed to load installs' }, 500)
    }
  })

  app.get('/installs/:installId/updates', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const installId = c.req.param('installId')
      const install = await prisma.marketplaceInstall.findUnique({
        where: { id: installId },
        select: { userId: true },
      })
      if (!install || install.userId !== authCtx.userId) {
        return c.json({ error: 'Forbidden' }, 403)
      }
      const result = await installService.checkForUpdates(installId)
      return c.json(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'install_not_found') {
        return c.json({ error: 'Install not found' }, 404)
      }
      console.error('[marketplace] checkForUpdates', err)
      return c.json({ error: 'Failed to check for updates' }, 500)
    }
  })

  app.post('/installs/:installId/update', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const installId = c.req.param('installId')
      const install = await prisma.marketplaceInstall.findUnique({
        where: { id: installId },
        select: { userId: true },
      })
      if (!install || install.userId !== authCtx.userId) {
        return c.json({ error: 'Forbidden' }, 403)
      }
      const result = await installService.applyUpdate(installId)
      if (!result.ok) {
        if (result.error === 'install_not_found') {
          return c.json({ error: result.error }, 404)
        }
        if (result.error === 'not_linked_install' || result.error === 'version_not_found') {
          return c.json({ error: result.error }, 400)
        }
        return c.json({ error: result.error }, 500)
      }
      return c.json(result)
    } catch (err) {
      console.error('[marketplace] applyUpdate', err)
      return c.json({ error: 'Failed to apply update' }, 500)
    }
  })

  app.post('/creator/profile', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    if (!authCtx.email) {
      return c.json({ error: 'Email required' }, 400)
    }
    try {
      const body = (await c.req.json()) as {
        displayName?: string
        bio?: string | null
        avatarUrl?: string | null
        websiteUrl?: string | null
      }
      if (!body.displayName || typeof body.displayName !== 'string') {
        return c.json({ error: 'displayName is required' }, 400)
      }
      const profile = await marketplaceService.createCreatorProfile(authCtx.userId, {
        displayName: body.displayName,
        bio: body.bio ?? undefined,
        avatarUrl: body.avatarUrl ?? undefined,
        websiteUrl: body.websiteUrl ?? undefined,
      })
      await stripeConnect.createCustomAccount(profile.id, authCtx.email)
      return c.json({ profile })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'P2002') {
        return c.json({ error: 'Creator profile already exists' }, 409)
      }
      console.error('[marketplace] createCreatorProfile', err)
      return c.json({ error: 'Failed to create creator profile' }, 500)
    }
  })

  app.get('/creator/profile', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const profile = await marketplaceService.getCreatorProfile(authCtx.userId)
      if (!profile) {
        return c.json({ error: 'Creator profile not found' }, 404)
      }
      return c.json({ profile })
    } catch (err) {
      console.error('[marketplace] getCreatorProfile', err)
      return c.json({ error: 'Failed to load profile' }, 500)
    }
  })

  app.patch('/creator/profile', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const body = (await c.req.json()) as Record<string, unknown>
      const data: marketplaceService.UpdateCreatorProfileData = {}
      if ('displayName' in body) data.displayName = body.displayName as string
      if ('bio' in body) data.bio = body.bio as string | null | undefined
      if ('avatarUrl' in body) data.avatarUrl = body.avatarUrl as string | null | undefined
      if ('websiteUrl' in body) data.websiteUrl = body.websiteUrl as string | null | undefined
      const profile = await marketplaceService.updateCreatorProfile(authCtx.userId, data)
      return c.json({ profile })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Record to update not found')) {
        return c.json({ error: 'Creator profile not found' }, 404)
      }
      console.error('[marketplace] updateCreatorProfile', err)
      return c.json({ error: 'Failed to update profile' }, 500)
    }
  })

  app.post('/creator/payout-details', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const profile = await marketplaceService.getCreatorProfile(authCtx.userId)
      if (!profile) {
        return c.json({ error: 'Creator profile not found' }, 404)
      }
      const details = (await c.req.json()) as stripeConnect.PayoutDetails
      await stripeConnect.submitPayoutDetails(profile.id, details)
      return c.json({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('no Stripe Connect account')) {
        return c.json({ error: msg }, 400)
      }
      console.error('[marketplace] submitPayoutDetails', err)
      return c.json({ error: 'Failed to submit payout details' }, 500)
    }
  })

  app.get('/creator/payout-status', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const profile = await marketplaceService.getCreatorProfile(authCtx.userId)
      if (!profile) {
        return c.json({ error: 'Creator profile not found' }, 404)
      }
      const status = await stripeConnect.getAccountStatus(profile.id)
      return c.json(status)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('no Stripe Connect account')) {
        return c.json({ error: msg }, 400)
      }
      console.error('[marketplace] getAccountStatus', err)
      return c.json({ error: 'Failed to load payout status' }, 500)
    }
  })

  app.get('/creator/dashboard', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const profile = await marketplaceService.getCreatorProfile(authCtx.userId)
      if (!profile) {
        return c.json({ error: 'Creator profile not found' }, 404)
      }
      const dashboard = await marketplaceService.getCreatorDashboard(profile.id)
      if (!dashboard) {
        return c.json({ error: 'Dashboard unavailable' }, 404)
      }
      return c.json(dashboard)
    } catch (err) {
      console.error('[marketplace] getCreatorDashboard', err)
      return c.json({ error: 'Failed to load dashboard' }, 500)
    }
  })

  app.get('/creator/listings', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const profile = await marketplaceService.getCreatorProfile(authCtx.userId)
      if (!profile) {
        return c.json({ error: 'Creator profile not found' }, 404)
      }
      const listings = await marketplaceService.getCreatorListings(profile.id)
      return c.json({ listings })
    } catch (err) {
      console.error('[marketplace] getCreatorListings', err)
      return c.json({ error: 'Failed to load listings' }, 500)
    }
  })

  app.post('/creator/listings', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const profile = await marketplaceService.getCreatorProfile(authCtx.userId)
      if (!profile) {
        return c.json({ error: 'Creator profile not found' }, 404)
      }
      const body = (await c.req.json()) as marketplaceService.CreateListingData & {
        projectId?: string
      }
      if (!body.projectId || typeof body.projectId !== 'string') {
        return c.json({ error: 'projectId is required' }, 400)
      }
      if (!body.title || typeof body.title !== 'string') {
        return c.json({ error: 'title is required' }, 400)
      }
      if (!body.shortDescription || typeof body.shortDescription !== 'string') {
        return c.json({ error: 'shortDescription is required' }, 400)
      }
      const { projectId, ...listingData } = body
      const listing = await marketplaceService.createListing(profile.id, projectId, listingData)
      return c.json({ listing })
    } catch (err) {
      console.error('[marketplace] createListing', err)
      return c.json({ error: 'Failed to create listing' }, 500)
    }
  })

  app.patch('/creator/listings/:id', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const profile = await marketplaceService.getCreatorProfile(authCtx.userId)
      if (!profile) {
        return c.json({ error: 'Creator profile not found' }, 404)
      }
      const listingId = c.req.param('id')
      const body = (await c.req.json()) as marketplaceService.UpdateListingData
      const listing = await marketplaceService.updateListing(listingId, profile.id, body)
      return c.json({ listing })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not found') || msg.includes('not owned')) {
        return c.json({ error: msg }, 404)
      }
      console.error('[marketplace] updateListing', err)
      return c.json({ error: 'Failed to update listing' }, 500)
    }
  })

  app.post('/creator/listings/:id/publish', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const profile = await marketplaceService.getCreatorProfile(authCtx.userId)
      if (!profile) {
        return c.json({ error: 'Creator profile not found' }, 404)
      }
      const listingId = c.req.param('id')
      const listing = await marketplaceService.publishListing(listingId, profile.id)
      try {
        await gamification.recalculateCreatorStats(profile.id)
      } catch (gamErr) {
        console.error('[marketplace] gamification recalc failed (non-fatal):', gamErr)
      }
      return c.json({ listing })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not found') || msg.includes('not owned')) {
        return c.json({ error: msg }, 404)
      }
      if (msg.includes('Only draft')) {
        return c.json({ error: msg }, 400)
      }
      console.error('[marketplace] publishListing', err)
      return c.json({ error: 'Failed to publish listing' }, 500)
    }
  })

  app.post('/creator/listings/:id/unpublish', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const profile = await marketplaceService.getCreatorProfile(authCtx.userId)
      if (!profile) {
        return c.json({ error: 'Creator profile not found' }, 404)
      }
      const listingId = c.req.param('id')
      const listing = await marketplaceService.unpublishListing(listingId, profile.id)
      try {
        await gamification.recalculateCreatorStats(profile.id)
      } catch (gamErr) {
        console.error('[marketplace] gamification recalc failed (non-fatal):', gamErr)
      }
      return c.json({ listing })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not found') || msg.includes('not owned')) {
        return c.json({ error: msg }, 404)
      }
      console.error('[marketplace] unpublishListing', err)
      return c.json({ error: 'Failed to unpublish listing' }, 500)
    }
  })

  app.post('/creator/listings/:id/versions', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const profile = await marketplaceService.getCreatorProfile(authCtx.userId)
      if (!profile) {
        return c.json({ error: 'Creator profile not found' }, 404)
      }
      const listingId = c.req.param('id')
      const body = (await c.req.json()) as {
        version?: string
        changelog?: string | null
        workspaceSnapshot?: Prisma.InputJsonValue
      }
      if (!body.version || typeof body.version !== 'string') {
        return c.json({ error: 'version is required' }, 400)
      }
      const owned = await prisma.marketplaceListing.findFirst({
        where: { id: listingId, creatorId: profile.id },
      })
      if (!owned) {
        return c.json({ error: 'Listing not found' }, 404)
      }
      const versionRow = await prisma.marketplaceListingVersion.create({
        data: {
          listingId,
          version: body.version,
          changelog: body.changelog ?? undefined,
          workspaceSnapshot: body.workspaceSnapshot ?? undefined,
        },
      })
      await prisma.marketplaceListing.update({
        where: { id: listingId },
        data: { currentVersion: body.version },
      })
      await gamification.updateMaintenanceStreak(profile.id)
      await gamification.recalculateCreatorStats(profile.id)
      return c.json({ version: versionRow })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'P2002') {
        return c.json({ error: 'Version already exists for this listing' }, 409)
      }
      console.error('[marketplace] push listing version', err)
      return c.json({ error: 'Failed to create version' }, 500)
    }
  })

  app.get('/creator/transactions', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const profile = await marketplaceService.getCreatorProfile(authCtx.userId)
      if (!profile) {
        return c.json({ error: 'Creator profile not found' }, 404)
      }
      const page = parseIntParam(c.req.query('page') ?? undefined, 1)
      const limit = parseIntParam(c.req.query('limit') ?? undefined, 20)
      const result = await marketplaceService.getCreatorTransactions(profile.id, page, limit)
      return c.json(result)
    } catch (err) {
      console.error('[marketplace] getCreatorTransactions', err)
      return c.json({ error: 'Failed to load transactions' }, 500)
    }
  })

  app.post('/:slug/install', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    if (!authCtx.email) {
      return c.json({ error: 'Email required for checkout' }, 400)
    }
    try {
      const slug = c.req.param('slug')
      const listing = await marketplaceService.getListingBySlug(slug)
      if (!listing) {
        return c.json({ error: 'Listing not found' }, 404)
      }
      const body = (await c.req.json()) as { workspaceId?: string }
      if (!body.workspaceId || typeof body.workspaceId !== 'string') {
        return c.json({ error: 'workspaceId is required' }, 400)
      }
      const creatorStripeId = listing.creator.stripeCustomAccountId
      const frontendUrl = getFrontendUrl()
      const successUrl = `${frontendUrl}/?marketplace_checkout=success&session_id={CHECKOUT_SESSION_ID}`
      const cancelUrl = `${frontendUrl}/?marketplace_checkout=canceled`

      if (listing.pricingModel === 'free') {
        const result = await installService.installAgent({
          listingId: listing.id,
          userId: authCtx.userId,
          workspaceId: body.workspaceId,
        })
        await gamification.recalculateCreatorStats(listing.creatorId)
        return c.json({ installed: true, ...result })
      }

      if (!creatorStripeId) {
        return c.json({ error: 'Creator is not set up to receive payments' }, 503)
      }

      if (listing.pricingModel === 'one_time') {
        const price = listing.priceInCents
        if (price == null || price <= 0) {
          return c.json({ error: 'Listing has no valid price' }, 400)
        }
        const url = await stripeConnect.createCheckoutSession({
          listingId: listing.id,
          buyerEmail: authCtx.email,
          priceInCents: price,
          creatorStripeAccountId: creatorStripeId,
          successUrl,
          cancelUrl,
          metadata: {
            workspaceId: body.workspaceId,
            userId: authCtx.userId,
          },
        })
        return c.json({ checkoutUrl: url })
      }

      if (listing.pricingModel === 'subscription') {
        const stripePriceId =
          listing.stripeMonthlyPriceId || listing.stripeAnnualPriceId || null
        if (!stripePriceId) {
          return c.json({ error: 'Listing has no Stripe subscription price' }, 400)
        }
        const url = await stripeConnect.createSubscriptionCheckout({
          listingId: listing.id,
          buyerEmail: authCtx.email,
          stripePriceId,
          creatorStripeAccountId: creatorStripeId,
          successUrl,
          cancelUrl,
          metadata: {
            workspaceId: body.workspaceId,
            userId: authCtx.userId,
          },
        })
        return c.json({ checkoutUrl: url })
      }

      return c.json({ error: 'Unsupported pricing model' }, 400)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Platform fee')) {
        return c.json({ error: msg }, 400)
      }
      if (msg === 'workspace_access_denied') {
        return c.json({ error: msg }, 403)
      }
      if (msg === 'listing_not_found' || msg === 'listing_not_published' || msg === 'install_not_found') {
        return c.json({ error: msg }, 404)
      }
      console.error('[marketplace] install', err)
      return c.json({ error: 'Install failed' }, 500)
    }
  })

  app.post('/:slug/reviews', async (c) => {
    const authCtx = c.get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
      const slug = c.req.param('slug')
      const listing = await marketplaceService.getListingBySlug(slug)
      if (!listing) {
        return c.json({ error: 'Listing not found' }, 404)
      }
      const body = (await c.req.json()) as {
        installId?: string
        rating?: number
        title?: string | null
        body?: string | null
      }
      if (!body.installId || typeof body.installId !== 'string') {
        return c.json({ error: 'installId is required' }, 400)
      }
      if (body.rating == null || typeof body.rating !== 'number') {
        return c.json({ error: 'rating is required' }, 400)
      }
      const review = await marketplaceService.createReview(listing.id, authCtx.userId, body.installId, {
        rating: body.rating,
        title: body.title,
        body: body.body,
      })
      await gamification.recalculateCreatorStats(listing.creatorId)
      return c.json({ review })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string }).code
      if (code === 'P2002' || msg.includes('Unique constraint failed')) {
        return c.json({ error: 'You already reviewed this listing' }, 409)
      }
      if (msg === 'Rating must be an integer from 1 to 5' || msg === 'Install not found for this user and listing') {
        return c.json({ error: msg }, 400)
      }
      console.error('[marketplace] createReview', err)
      return c.json({ error: 'Failed to create review' }, 500)
    }
  })

  app.get('/:slug/reviews', async (c) => {
    try {
      const slug = c.req.param('slug')
      const listing = await marketplaceService.getListingBySlug(slug)
      if (!listing) {
        return c.json({ error: 'Listing not found' }, 404)
      }
      const page = parseIntParam(c.req.query('page') ?? undefined, 1)
      const limit = parseIntParam(c.req.query('limit') ?? undefined, 20)
      const result = await marketplaceService.getReviews(listing.id, page, limit)
      return c.json(result)
    } catch (err) {
      console.error('[marketplace] getReviews', err)
      return c.json({ error: 'Failed to load reviews' }, 500)
    }
  })

  app.get('/:slug', async (c) => {
    try {
      const listing = await marketplaceService.getListingBySlug(c.req.param('slug'))
      if (!listing) {
        return c.json({ error: 'Listing not found' }, 404)
      }
      return c.json({ listing })
    } catch (err) {
      console.error('[marketplace] getListingBySlug', err)
      return c.json({ error: 'Failed to load listing' }, 500)
    }
  })

  return app
}
