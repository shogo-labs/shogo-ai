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
   * GET /analytics/usage - Usage/credit analytics
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

  return router
}
