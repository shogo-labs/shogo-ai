// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Affiliate / MLM program HTTP routes.
 *
 * Mounted at `/api` from server.ts (the route paths embed `/affiliates`
 * so they resolve to `/api/affiliates/*`). Auth split:
 *
 *   - Authenticated user routes (`/api/affiliates/me/...`): require
 *     a logged-in session via `authMiddleware + requireAuth`. The
 *     middleware populates `c.get('auth').userId`.
 *
 *   - `POST /api/affiliates/enroll`: opt-in enrollment. Authenticated.
 *
 *   - `POST /api/affiliates/click`: server-to-server from the
 *     marketing-site Cloudflare Pages Function. Gated on a shared
 *     `SHOGO_INTERNAL_SECRET` header — no user session.
 *
 *   - `GET /api/affiliates/lookup`: public, used by the Cloudflare
 *     Function to validate a code before redirect for nicer 404 UX.
 *     Rate-limit budget is small (the function caches negative
 *     results client-side).
 *
 * All routes are no-ops or 503s when `SHOGO_AFFILIATES_NATIVE !== 'true'`
 * so unintentional deploys before the rollout flip don't leak the
 * surface area to users.
 */

import { Hono } from 'hono'
import { z } from 'zod'

import { authMiddleware, requireAuth } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import {
  AffiliateError,
  enrollAffiliate,
  getAffiliateSummary,
  recordClick,
} from '../services/affiliate.service'

function isFlagOn(): boolean {
  return process.env.SHOGO_AFFILIATES_NATIVE === 'true'
}

function affiliateErrorStatus(code: string): number {
  switch (code) {
    case 'terms_required':
    case 'invalid_code':
    case 'code_taken':
    case 'parent_too_deep':
    case 'parent_inactive':
    case 'self_referral':
    case 'cycle':
      return 400
    case 'parent_not_found':
    case 'affiliate_not_found':
    case 'user_not_found':
      return 404
    case 'affiliate_inactive':
      return 410
    default:
      return 500
  }
}

const enrollSchema = z.object({
  parentCode: z.string().trim().min(1).max(64).optional().nullable(),
  code: z.string().trim().min(2).max(40).optional().nullable(),
  termsAccepted: z.boolean(),
})

const clickSchema = z.object({
  code: z.string().min(1).max(64),
  visitorId: z.string().min(8).max(128),
  ip: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  landingPage: z.string().nullable().optional(),
  utmSource: z.string().nullable().optional(),
  utmMedium: z.string().nullable().optional(),
  utmCampaign: z.string().nullable().optional(),
  referrer: z.string().nullable().optional(),
  country: z.string().length(2).nullable().optional(),
})

export function affiliateRoutes(): Hono {
  const router = new Hono()

  // --------------------------------------------------------------------------
  // Public + internal endpoints — no per-user auth
  // --------------------------------------------------------------------------

  /**
   * POST /api/affiliates/click
   * Internal server-to-server hook called by the Cloudflare Pages
   * Function at /r/:code. Gated by SHOGO_INTERNAL_SECRET.
   */
  router.post('/affiliates/click', async (c) => {
    if (!isFlagOn()) {
      return c.json({ ok: false, error: { code: 'feature_disabled' } }, 503)
    }
    const provided = c.req.header('x-shogo-internal-secret') || ''
    const expected = process.env.SHOGO_INTERNAL_SECRET
    if (!expected || provided !== expected) {
      return c.json({ ok: false, error: { code: 'unauthorized' } }, 401)
    }
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: { code: 'bad_request' } }, 400)
    }
    const parsed = clickSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { ok: false, error: { code: 'invalid_request', issues: parsed.error.issues } },
        400,
      )
    }
    try {
      const click = await recordClick(parsed.data as any)
      return c.json({ ok: true, clickId: click.id })
    } catch (err) {
      if (err instanceof AffiliateError) {
        // Bad slug is the most common path — return 200 so the
        // Cloudflare Function doesn't get retried; it'll still set
        // the cookie regardless.
        return c.json(
          { ok: false, error: { code: err.code, message: err.message } },
          err.code === 'affiliate_not_found' ? 404 : affiliateErrorStatus(err.code),
        )
      }
      console.error('[Affiliate click] failed', err)
      return c.json({ ok: false, error: { code: 'server_error' } }, 500)
    }
  })

  /**
   * GET /api/affiliates/lookup?code=...
   * Public, lets the marketing site validate codes for a nicer 404 UX.
   * Returns minimal data: `{ exists, displayName }`.
   */
  router.get('/affiliates/lookup', async (c) => {
    if (!isFlagOn()) return c.json({ exists: false })
    const code = (c.req.query('code') || '').toLowerCase().trim()
    if (!code) return c.json({ exists: false })
    const affiliate = await prisma.affiliate.findUnique({
      where: { code },
      select: { id: true, status: true, user: { select: { name: true } } },
    })
    if (!affiliate || affiliate.status !== 'active') return c.json({ exists: false })
    return c.json({
      exists: true,
      displayName: (affiliate as any).user?.name ?? null,
    })
  })

  // --------------------------------------------------------------------------
  // Authenticated user endpoints
  // --------------------------------------------------------------------------
  router.use('/affiliates/me/*', authMiddleware)
  router.use('/affiliates/me/*', requireAuth)
  router.use('/affiliates/enroll', authMiddleware)
  router.use('/affiliates/enroll', requireAuth)

  /** POST /api/affiliates/enroll — opt in. Idempotent on userId. */
  router.post('/affiliates/enroll', async (c) => {
    if (!isFlagOn()) {
      return c.json({ ok: false, error: { code: 'feature_disabled' } }, 503)
    }
    const auth = c.get('auth') as { userId?: string } | undefined
    const userId = auth?.userId
    if (!userId) return c.json({ ok: false, error: { code: 'unauthorized' } }, 401)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: { code: 'bad_request' } }, 400)
    }
    const parsed = enrollSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { ok: false, error: { code: 'invalid_request', issues: parsed.error.issues } },
        400,
      )
    }
    try {
      const aff = await enrollAffiliate(userId, parsed.data)
      return c.json({ ok: true, affiliate: aff })
    } catch (err) {
      if (err instanceof AffiliateError) {
        return c.json(
          { ok: false, error: { code: err.code, message: err.message } },
          affiliateErrorStatus(err.code),
        )
      }
      console.error('[Affiliate enroll] failed', err)
      return c.json({ ok: false, error: { code: 'server_error' } }, 500)
    }
  })

  /** GET /api/affiliates/me — own profile + 30d dashboard summary. */
  router.get('/affiliates/me', async (c) => {
    if (!isFlagOn()) {
      return c.json({ ok: false, error: { code: 'feature_disabled' } }, 503)
    }
    const auth = c.get('auth') as { userId?: string } | undefined
    const userId = auth?.userId
    if (!userId) return c.json({ ok: false, error: { code: 'unauthorized' } }, 401)
    const summary = await getAffiliateSummary(userId)
    if (!summary) return c.json({ ok: true, enrolled: false })
    return c.json({ ok: true, enrolled: true, ...summary })
  })

  /**
   * GET /api/affiliates/me/commissions?status=&limit=&cursor=
   * Cursor-paginated list of the caller's commission rows.
   */
  router.get('/affiliates/me/commissions', async (c) => {
    if (!isFlagOn()) return c.json({ ok: false, error: { code: 'feature_disabled' } }, 503)
    const auth = c.get('auth') as { userId?: string } | undefined
    const userId = auth?.userId
    if (!userId) return c.json({ ok: false, error: { code: 'unauthorized' } }, 401)
    const affiliate = await prisma.affiliate.findUnique({ where: { userId }, select: { id: true } })
    if (!affiliate) return c.json({ ok: true, commissions: [], nextCursor: null })

    const status = c.req.query('status')
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 200)
    const cursor = c.req.query('cursor') || null
    const where: any = { affiliateId: affiliate.id }
    if (status) where.status = status
    const rows = await prisma.affiliateCommission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    const hasMore = rows.length > limit
    const out = hasMore ? rows.slice(0, limit) : rows
    return c.json({
      ok: true,
      commissions: out,
      nextCursor: hasMore ? out[out.length - 1]?.id : null,
    })
  })

  /** GET /api/affiliates/me/payouts — list of past + pending payouts. */
  router.get('/affiliates/me/payouts', async (c) => {
    if (!isFlagOn()) return c.json({ ok: false, error: { code: 'feature_disabled' } }, 503)
    const auth = c.get('auth') as { userId?: string } | undefined
    const userId = auth?.userId
    if (!userId) return c.json({ ok: false, error: { code: 'unauthorized' } }, 401)
    const affiliate = await prisma.affiliate.findUnique({ where: { userId }, select: { id: true } })
    if (!affiliate) return c.json({ ok: true, payouts: [] })
    const payouts = await prisma.affiliatePayout.findMany({
      where: { affiliateId: affiliate.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return c.json({ ok: true, payouts })
  })

  /**
   * GET /api/affiliates/me/downline?level=
   * Returns direct children when `level` is unset; `level=all` flattens
   * the whole tree up to SHOGO_AFFILIATE_MAX_DEPTH. PII redaction:
   * only `displayName` from the user record is exposed.
   */
  router.get('/affiliates/me/downline', async (c) => {
    if (!isFlagOn()) return c.json({ ok: false, error: { code: 'feature_disabled' } }, 503)
    const auth = c.get('auth') as { userId?: string } | undefined
    const userId = auth?.userId
    if (!userId) return c.json({ ok: false, error: { code: 'unauthorized' } }, 401)
    const affiliate = await prisma.affiliate.findUnique({ where: { userId }, select: { id: true } })
    if (!affiliate) return c.json({ ok: true, downline: [] })

    const level = c.req.query('level') || ''
    const wantsAll = level === 'all'

    const direct: any[] = await prisma.affiliate.findMany({
      where: { parentAffiliateId: affiliate.id },
      select: {
        id: true, code: true, depth: true, createdAt: true,
        user: { select: { name: true } },
      },
    })
    let downline = direct.map((d: any) => ({
      id: d.id, code: d.code, depth: d.depth, level: 1,
      displayName: d.user?.name ?? null, createdAt: d.createdAt,
    }))

    if (wantsAll) {
      const maxDepth =
        Number.isFinite(parseInt(process.env.SHOGO_AFFILIATE_MAX_DEPTH || '3', 10))
          ? parseInt(process.env.SHOGO_AFFILIATE_MAX_DEPTH || '3', 10)
          : 3
      let frontier = direct.map((d: any) => d.id)
      for (let lvl = 2; lvl <= maxDepth && frontier.length > 0; lvl++) {
        const next: any[] = await prisma.affiliate.findMany({
          where: { parentAffiliateId: { in: frontier } },
          select: {
            id: true, code: true, depth: true, createdAt: true,
            user: { select: { name: true } },
          },
        })
        downline = downline.concat(
          next.map((d: any) => ({
            id: d.id, code: d.code, depth: d.depth, level: lvl,
            displayName: d.user?.name ?? null, createdAt: d.createdAt,
          })),
        )
        frontier = next.map((n: any) => n.id)
      }
    }

    return c.json({ ok: true, downline })
  })

  /**
   * POST /api/affiliates/me/stripe-connect/onboard
   * Reuses the marketplace stripe-connect.service onboarding helper to
   * create a Stripe Custom account for the affiliate and return an
   * onboarding URL. Affiliates and CreatorProfiles deliberately get
   * separate Connect accounts — tax categorization differs.
   */
  router.post('/affiliates/me/stripe-connect/onboard', async (c) => {
    if (!isFlagOn()) return c.json({ ok: false, error: { code: 'feature_disabled' } }, 503)
    const auth = c.get('auth') as { userId?: string } | undefined
    const userId = auth?.userId
    if (!userId) return c.json({ ok: false, error: { code: 'unauthorized' } }, 401)
    const affiliate = await prisma.affiliate.findUnique({ where: { userId } })
    if (!affiliate) return c.json({ ok: false, error: { code: 'not_enrolled' } }, 404)

    try {
      const { createCustomAccountForAffiliate } = await import('../services/stripe-connect.service')
      // Marketplace's createCustomAccount is keyed on CreatorProfile id;
      // affiliates need their own thin wrapper that mirrors the shape
      // but writes the Connect account id back to Affiliate. The wrapper
      // is added alongside the existing helpers in stripe-connect.service.
      const onboardUrl = await (createCustomAccountForAffiliate as any)(affiliate.id)
      return c.json({ ok: true, onboardUrl, payoutStatus: affiliate.payoutStatus })
    } catch (err: any) {
      // The wrapper may not exist yet on stacks that haven't taken
      // the latest stripe-connect.service patch. Surface a 501 so
      // the mobile client can prompt for an app update.
      if (err?.code === 'ERR_MODULE_NOT_FOUND' || /createCustomAccountForAffiliate/.test(String(err))) {
        return c.json({ ok: false, error: { code: 'not_implemented', message: 'Affiliate Connect onboarding not enabled on this deployment' } }, 501)
      }
      console.error('[Affiliate onboard] failed', err)
      return c.json({ ok: false, error: { code: 'server_error', message: err?.message } }, 500)
    }
  })

  /** POST /api/affiliates/me/stripe-connect/details — wraps submitPayoutDetails. */
  router.post('/affiliates/me/stripe-connect/details', async (c) => {
    if (!isFlagOn()) return c.json({ ok: false, error: { code: 'feature_disabled' } }, 503)
    const auth = c.get('auth') as { userId?: string } | undefined
    const userId = auth?.userId
    if (!userId) return c.json({ ok: false, error: { code: 'unauthorized' } }, 401)
    const affiliate = await prisma.affiliate.findUnique({ where: { userId } })
    if (!affiliate?.stripeCustomAccountId) {
      return c.json({ ok: false, error: { code: 'not_onboarded' } }, 400)
    }
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ ok: false, error: { code: 'bad_request' } }, 400) }

    try {
      const { submitPayoutDetailsForAffiliate } = await import('../services/stripe-connect.service')
      const result = await (submitPayoutDetailsForAffiliate as any)(affiliate.id, body)
      return c.json({ ok: true, ...result })
    } catch (err: any) {
      if (/submitPayoutDetailsForAffiliate/.test(String(err))) {
        return c.json({ ok: false, error: { code: 'not_implemented' } }, 501)
      }
      console.error('[Affiliate connect details] failed', err)
      return c.json({ ok: false, error: { code: 'server_error', message: err?.message } }, 500)
    }
  })

  return router
}

export default affiliateRoutes
