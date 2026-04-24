// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Analytics Routes
 *
 * Custom admin endpoints for platform-wide analytics.
 * CRUD operations for all models are handled by the auto-generated
 * admin-routes.ts (via createAdminRoutes in the SDK).
 *
 * Mounted at /api/admin/* alongside the generated admin CRUD routes.
 */

import { Hono } from 'hono'
import { requireSuperAdmin } from '../middleware/super-admin'
import { authMiddleware, requireAuth } from '../middleware/auth'
import * as analytics from '../services/analytics.service'
import type { AnalyticsPeriod } from '../services/analytics.service'
import { prisma } from '../lib/prisma'

// ============================================================================
// Admin Analytics Routes
// ============================================================================

export function adminRoutes(): Hono {
  const router = new Hono()

  // Apply auth + super admin middleware to all routes
  router.use('*', authMiddleware)
  router.use('*', requireAuth)
  router.use('*', requireSuperAdmin)

  // --------------------------------------------------------------------------
  // Platform Analytics (scope-free = platform-wide)
  // --------------------------------------------------------------------------

  /**
   * GET /analytics/overview - Platform overview stats
   */
  router.get('/analytics/overview', async (c) => {
    try {
      const data = await analytics.getOverviewStats()
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Analytics overview error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/growth - Growth time series
   */
  router.get('/analytics/growth', async (c) => {
    try {
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod
      const data = await analytics.getGrowthTimeSeries({}, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Analytics growth error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/usage - Usage/spend analytics
   */
  router.get('/analytics/usage', async (c) => {
    try {
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod
      const data = await analytics.getUsageAnalytics({}, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Analytics usage error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/active-users - Active user metrics
   */
  router.get('/analytics/active-users', async (c) => {
    try {
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod
      const data = await analytics.getActiveUsers({}, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Analytics active users error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/chat - Chat activity analytics
   */
  router.get('/analytics/chat', async (c) => {
    try {
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod
      const data = await analytics.getChatAnalytics({}, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Analytics chat error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/projects - Project distribution analytics
   */
  router.get('/analytics/projects', async (c) => {
    try {
      const data = await analytics.getProjectAnalytics()
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Analytics projects error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/billing - Billing/revenue analytics
   */
  router.get('/analytics/billing', async (c) => {
    try {
      const data = await analytics.getBillingAnalytics()
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Analytics billing error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/usage-log - Paginated AI proxy usage event log
   */
  router.get('/analytics/usage-log', async (c) => {
    try {
      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const page = parseInt(url.searchParams.get('page') || '1', 10)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const userId = url.searchParams.get('userId') || undefined
      const model = url.searchParams.get('model') || undefined

      const data = await analytics.getUsageLog({}, period, { page, limit, userId, model })
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Usage log error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/usage-summary - Aggregated usage by user + model
   */
  router.get('/analytics/usage-summary', async (c) => {
    try {
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod
      const data = await analytics.getUsageSummary({}, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Usage summary error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Infrastructure Metrics (backed by InfraSnapshot table)
  // --------------------------------------------------------------------------

  /**
   * GET /analytics/infra-current - Latest snapshot + live warm pool status
   */
  router.get('/analytics/infra-current', async (c) => {
    try {
      const latest = await prisma.infraSnapshot.findFirst({
        orderBy: { timestamp: 'desc' },
      })

      let live = null
      try {
        const { getWarmPoolController } = await import('../lib/warm-pool-controller')
        const controller = getWarmPoolController()
        const extended = await controller.getExtendedStatus()
        live = {
          cluster: extended.cluster,
          pool: {
            enabled: extended.enabled,
            available: extended.available,
            assigned: extended.assigned,
            targetSize: extended.targetSize,
          },
          gcStats: extended.gcStats,
        }
      } catch {
        // Not running in K8s — live data unavailable
      }

      return c.json({ ok: true, data: { snapshot: latest, live } })
    } catch (error: any) {
      console.error('[Admin] Infra current error:', error)
      return c.json({ error: { code: 'infra_failed', message: error.message } }, 500)
    }
  })

  type InfraPeriod = '1h' | '6h' | '24h' | '7d' | '30d'

  const infraPeriodMs: Record<InfraPeriod, number> = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  }

  /**
   * GET /analytics/infra-history - Time-series infrastructure snapshots
   */
  router.get('/analytics/infra-history', async (c) => {
    try {
      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '24h') as InfraPeriod
      const ms = infraPeriodMs[period] ?? infraPeriodMs['24h']
      const since = new Date(Date.now() - ms)

      const snapshots = await prisma.infraSnapshot.findMany({
        where: { timestamp: { gte: since } },
        orderBy: { timestamp: 'asc' },
        select: {
          timestamp: true,
          totalNodes: true,
          asgDesired: true,
          totalPodSlots: true,
          usedPodSlots: true,
          totalCpuMillis: true,
          usedCpuMillis: true,
          limitCpuMillis: true,
          warmAvailable: true,
          warmTarget: true,
          warmAssigned: true,
          totalProjects: true,
          readyProjects: true,
          runningProjects: true,
          scaledToZero: true,
        },
      })

      return c.json({ ok: true, data: snapshots })
    } catch (error: any) {
      console.error('[Admin] Infra history error:', error)
      return c.json({ error: { code: 'infra_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // User Funnel
  // --------------------------------------------------------------------------

  router.get('/analytics/funnel', async (c) => {
    try {
      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const excludeInternal = url.searchParams.get('excludeInternal') !== 'false'
      const data = await analytics.getUserFunnel(period, excludeInternal)
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Funnel error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // User Activity Table
  // --------------------------------------------------------------------------

  router.get('/analytics/user-activity', async (c) => {
    try {
      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const page = parseInt(url.searchParams.get('page') || '1', 10)
      const limit = parseInt(url.searchParams.get('limit') || '20', 10)
      const sort = url.searchParams.get('sort') || undefined
      const excludeInternal = url.searchParams.get('excludeInternal') !== 'false'
      const data = await analytics.getUserActivityTable(period, { page, limit, sort, excludeInternal })
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] User activity error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Template Engagement
  // --------------------------------------------------------------------------

  router.get('/analytics/template-engagement', async (c) => {
    try {
      const url = new URL(c.req.url)
      const excludeInternal = url.searchParams.get('excludeInternal') !== 'false'
      const data = await analytics.getTemplateEngagement(excludeInternal)
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Template engagement error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Source Breakdown
  // --------------------------------------------------------------------------

  router.get('/analytics/source-breakdown', async (c) => {
    try {
      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const excludeInternal = url.searchParams.get('excludeInternal') !== 'false'
      const data = await analytics.getSourceBreakdown(period, excludeInternal)
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Source breakdown error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // AI Digest
  // --------------------------------------------------------------------------

  router.get('/analytics/ai-digest', async (c) => {
    try {
      const url = new URL(c.req.url)
      const dateStr = url.searchParams.get('date')
      const where = dateStr
        ? { date: new Date(dateStr), period: '24h' }
        : { period: '24h' }
      const digest = await prisma.analyticsDigest.findFirst({
        where,
        orderBy: { date: 'desc' },
      })
      return c.json({ ok: true, data: digest })
    } catch (error: any) {
      console.error('[Admin] AI digest error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/analytics/ai-digest/list', async (c) => {
    try {
      const url = new URL(c.req.url)
      const limit = parseInt(url.searchParams.get('limit') || '7', 10)
      const digests = await prisma.analyticsDigest.findMany({
        where: { period: '24h' },
        orderBy: { date: 'desc' },
        take: Math.min(limit, 90),
        select: {
          id: true,
          date: true,
          funnelSignups: true,
          funnelEngaged: true,
          activeUsers: true,
          totalMessages: true,
          messagesAnalyzed: true,
          createdAt: true,
        },
      })
      return c.json({ ok: true, data: digests })
    } catch (error: any) {
      console.error('[Admin] AI digest list error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.post('/analytics/ai-digest/generate', async (c) => {
    try {
      const { generateDigest } = await import('../lib/analytics-digest-collector')
      const digest = await generateDigest(prisma)
      return c.json({ ok: true, data: digest })
    } catch (error: any) {
      console.error('[Admin] AI digest generate error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  return router
}

// ============================================================================
// User Attribution Route (separate from admin — authenticated users only)
// ============================================================================

export function userAttributionRoute(): Hono {
  const router = new Hono()
  router.use('*', authMiddleware)
  router.use('*', requireAuth)

  router.post('/users/me/attribution', async (c) => {
    try {
      const user = (c as any).get('user')
      if (!user?.id) return c.json({ error: 'unauthorized' }, 401)

      const body = await c.req.json()
      const sourceTag = analytics.deriveSourceTag({
        utmSource: body.utmSource,
        utmMedium: body.utmMedium,
        referrer: body.referrer,
        method: body.method,
      })

      await prisma.signupAttribution.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          utmSource: body.utmSource || null,
          utmMedium: body.utmMedium || null,
          utmCampaign: body.utmCampaign || null,
          utmContent: body.utmContent || null,
          utmTerm: body.utmTerm || null,
          referrer: body.referrer || null,
          landingPage: body.landingPage || null,
          signupMethod: body.method || null,
          sourceTag,
        },
        update: {},
      })

      return c.json({ ok: true })
    } catch (error: any) {
      console.error('[Attribution] Error:', error)
      return c.json({ error: { code: 'attribution_failed', message: error.message } }, 500)
    }
  })

  return router
}
