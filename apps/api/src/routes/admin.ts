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
import { requireAdminScope } from '../middleware/admin-access'
import { ADMIN_SCOPES, isAdminScope, normalizeAdminScopes, type AdminScope } from '../lib/admin-scopes'
import { authMiddleware, requireAuth } from '../middleware/auth'
import * as analytics from '../services/analytics.service'
import type { AnalyticsPeriod } from '../services/analytics.service'
import { resolveModelLabel, resolveModelLabels } from '../services/model-registry.service'
import {
  getContentSettings,
  setContentSettings,
  getEnsembleDataTokenInfo,
  setEnsembleDataToken,
  type ContentSettingsPatch,
} from '../services/affiliate-content-settings.service'
import { prisma } from '../lib/prisma'

// ============================================================================
// Admin Analytics Routes
// ============================================================================

export function adminRoutes(): Hono {
  const router = new Hono()

  // All admin routes require authentication.
  router.use('*', authMiddleware)
  router.use('*', requireAuth)

  // Scoped authorization. A super_admin passes every check (see
  // requireAdminScope); partial admins pass only the scopes they hold.
  //
  // Sensitive surfaces stay super_admin-only. These are registered *before*
  // the broad '/analytics/*' scope gate so they short-circuit first: a
  // scoped analytics admin hitting infra is rejected by requireSuperAdmin
  // rather than slipping through the analytics:read gate.
  router.use('/analytics/infra-current', requireSuperAdmin)
  router.use('/analytics/infra-history', requireSuperAdmin)
  router.use('/heartbeats', requireSuperAdmin)
  router.use('/heartbeats/*', requireSuperAdmin)
  router.use('/affiliates/*', requireSuperAdmin)

  // Assigning admin scopes to a user is itself a privileged action — keep it
  // super_admin-only so partial admins cannot escalate their own access.
  router.use('/users/:id/admin-access', requireSuperAdmin)

  // Delegable surfaces, gated by granular scopes. '/creators' is the exact
  // list path; '/creators/*' covers the per-creator profile detail. Both must
  // also be deferred by requireSuperAdminUnlessScoped (see
  // middleware/admin-access.ts isScopeGatedAdminPath) so the generated CRUD
  // router's blanket super-admin gate doesn't 403 scoped admins first.
  router.use('/creators', requireAdminScope('creators:read'))
  router.use('/creators/*', requireAdminScope('creators:read'))
  router.use('/analytics/*', requireAdminScope('analytics:read'))

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
      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const page = parseInt(url.searchParams.get('page') || '1', 10)
      const limit = parseInt(url.searchParams.get('limit') || '25', 10)
      const excludeInternal = url.searchParams.get('excludeInternal') !== 'false'
      const data = await analytics.getUsageSummary({}, period, { page, limit, excludeInternal })
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Usage summary error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/spend-timeseries - Daily consumption grouped by
   * model / workspace / user / source (stacked-area chart).
   */
  router.get('/analytics/spend-timeseries', async (c) => {
    try {
      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const fromIso = url.searchParams.get('from') || undefined
      const toIso = url.searchParams.get('to') || undefined
      const groupBy = (url.searchParams.get('groupBy') || 'model') as 'model' | 'workspace' | 'user' | 'source'
      const metric = (url.searchParams.get('metric') || 'spend') as 'spend' | 'tokens' | 'requests'
      const topN = parseInt(url.searchParams.get('topN') || '8', 10)

      const data = await analytics.getSpendTimeseries({}, period, { fromIso, toIso, groupBy, metric, topN })
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Spend timeseries error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/activity-timeseries - Combined daily activity metrics
   * (new users / workspaces / projects, messages, sessions, tool calls).
   */
  router.get('/analytics/activity-timeseries', async (c) => {
    try {
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod
      const data = await analytics.getActivityTimeseries({}, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Activity timeseries error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/active-users-timeseries - Daily rolling DAU/WAU/MAU.
   */
  router.get('/analytics/active-users-timeseries', async (c) => {
    try {
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod
      const data = await analytics.getActiveUsersTimeseries({}, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Active users timeseries error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/quality-timeseries - Daily cache hit ratio, unit economics,
   * and agent quality rates.
   */
  router.get('/analytics/quality-timeseries', async (c) => {
    try {
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod
      const data = await analytics.getQualityTimeseries({}, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Quality timeseries error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/tool-calls - Tool-call usage and success-rate analytics.
   */
  router.get('/analytics/tool-calls', async (c) => {
    try {
      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const excludeInternal = url.searchParams.get('excludeInternal') !== 'false'
      const data = await analytics.getToolCallAnalytics({}, period, { excludeInternal })
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Tool calls analytics error:', error)
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /analytics/workspace-activity - Paginated per-workspace activity table.
   */
  router.get('/analytics/workspace-activity', async (c) => {
    try {
      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const page = parseInt(url.searchParams.get('page') || '1', 10)
      const limit = parseInt(url.searchParams.get('limit') || '20', 10)
      const excludeInternal = url.searchParams.get('excludeInternal') !== 'false'
      const data = await analytics.getWorkspaceActivityTable(period, { page, limit, excludeInternal })
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Workspace activity error:', error)
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

  // --------------------------------------------------------------------------
  // Heartbeats — observability + control of the autonomous-agent scheduler
  //
  // Note: the scheduler is per-API-process state (running flag, paused flag,
  // circuit-breaker map, tick counters). In multi-pod production deployments
  // each pod has its own scheduler instance, so pause/resume and stats only
  // reflect the API pod that handled the request. The DB-backed AgentConfig
  // edits below are global.
  // --------------------------------------------------------------------------

  /**
   * GET /heartbeats/overview - Scheduler health + aggregate counts.
   */
  router.get('/heartbeats/overview', async (c) => {
    try {
      const { getActiveHeartbeatScheduler, getSchedulerKind } = await import('../lib/admin-heartbeat')
      const scheduler = await getActiveHeartbeatScheduler()
      const stats = scheduler.getStats()
      const breaker = scheduler.getBreakerSnapshot()

      const [enabledCount, totalCount, dueNow] = await Promise.all([
        prisma.agentConfig.count({ where: { heartbeatEnabled: true } }),
        prisma.agentConfig.count(),
        prisma.agentConfig.count({
          where: {
            heartbeatEnabled: true,
            nextHeartbeatAt: { lte: new Date() },
          },
        }),
      ])

      // Hydrate breaker snapshot with project + workspace names for display.
      let backoff: Array<{
        projectId: string
        projectName: string | null
        workspaceName: string | null
        count: number
        backoffUntil: number
      }> = []
      if (breaker.length > 0) {
        const projects = await prisma.project.findMany({
          where: { id: { in: breaker.map((b) => b.projectId) } },
          select: { id: true, name: true, workspace: { select: { name: true } } },
        })
        const byId = new Map(projects.map((p) => [p.id, p]))
        backoff = breaker
          .map((b) => ({
            projectId: b.projectId,
            projectName: byId.get(b.projectId)?.name ?? null,
            workspaceName: byId.get(b.projectId)?.workspace?.name ?? null,
            count: b.count,
            backoffUntil: b.backoffUntil,
          }))
          .sort((a, b) => b.count - a.count)
      }

      return c.json({
        ok: true,
        data: {
          kind: getSchedulerKind(),
          stats,
          counts: {
            enabled: enabledCount,
            total: totalCount,
            dueNow,
            inBackoff: breaker.length,
          },
          backoff,
        },
      })
    } catch (error: any) {
      console.error('[Admin] Heartbeats overview error:', error)
      return c.json({ error: { code: 'heartbeats_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /heartbeats - Paginated list of agent configs with breaker state.
   *
   * Query params:
   *   - page (default 1)
   *   - pageSize (default 50, max 200)
   *   - search (matches project or workspace name, case-insensitive)
   *   - enabledOnly=true
   *   - dueWithinSec=N (only configs whose nextHeartbeatAt <= now + N seconds)
   *   - inBackoff=true (intersects with current circuit-breaker snapshot)
   *   - sort=nextHeartbeatAt|lastHeartbeatAt|projectName (default nextHeartbeatAt)
   */
  router.get('/heartbeats', async (c) => {
    try {
      const url = new URL(c.req.url)
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
      const pageSize = Math.min(
        200,
        Math.max(1, parseInt(url.searchParams.get('pageSize') || '50', 10))
      )
      const search = url.searchParams.get('search')?.trim() || ''
      const enabledOnly = url.searchParams.get('enabledOnly') === 'true'
      const dueWithinSec = parseInt(url.searchParams.get('dueWithinSec') || '', 10)
      const inBackoffFilter = url.searchParams.get('inBackoff') === 'true'
      const sortKey = url.searchParams.get('sort') || 'nextHeartbeatAt'

      const { getActiveHeartbeatScheduler } = await import('../lib/admin-heartbeat')
      const scheduler = await getActiveHeartbeatScheduler()
      const breaker = scheduler.getBreakerSnapshot()
      const breakerById = new Map(breaker.map((b) => [b.projectId, b]))

      const where: any = {}
      if (enabledOnly) where.heartbeatEnabled = true
      if (Number.isFinite(dueWithinSec)) {
        where.nextHeartbeatAt = { lte: new Date(Date.now() + dueWithinSec * 1000) }
      }
      if (inBackoffFilter) {
        if (breaker.length === 0) {
          return c.json({
            ok: true,
            data: { rows: [], page, pageSize, total: 0 },
          })
        }
        where.projectId = { in: breaker.map((b) => b.projectId) }
      }
      if (search) {
        where.project = {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { workspace: { name: { contains: search, mode: 'insensitive' } } },
          ],
        }
      }

      let orderBy: any
      switch (sortKey) {
        case 'lastHeartbeatAt':
          orderBy = { lastHeartbeatAt: 'desc' }
          break
        case 'projectName':
          orderBy = { project: { name: 'asc' } }
          break
        case 'nextHeartbeatAt':
        default:
          orderBy = { nextHeartbeatAt: 'asc' }
          break
      }

      const [total, rows] = await Promise.all([
        prisma.agentConfig.count({ where }),
        prisma.agentConfig.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            projectId: true,
            heartbeatEnabled: true,
            heartbeatInterval: true,
            nextHeartbeatAt: true,
            lastHeartbeatAt: true,
            quietHoursStart: true,
            quietHoursEnd: true,
            quietHoursTimezone: true,
            modelProvider: true,
            modelName: true,
            updatedAt: true,
            project: {
              select: {
                id: true,
                name: true,
                workspaceId: true,
                workspace: { select: { id: true, name: true, slug: true } },
              },
            },
          },
        }),
      ])

      // agent_configs.modelName is an opaque UUID for DB models post catalog-uuid
      // migration; resolve display labels (id kept intact for the model picker).
      const modelLabels = await resolveModelLabels(
        rows.map((r) => r.modelName).filter((m): m is string => !!m),
      )
      const enriched = rows.map((row) => {
        const b = breakerById.get(row.projectId)
        return {
          ...row,
          modelLabel: row.modelName ? (modelLabels.get(row.modelName) ?? row.modelName) : null,
          breaker: b ? { count: b.count, backoffUntil: b.backoffUntil } : null,
        }
      })

      return c.json({
        ok: true,
        data: { rows: enriched, page, pageSize, total },
      })
    } catch (error: any) {
      console.error('[Admin] Heartbeats list error:', error)
      return c.json({ error: { code: 'heartbeats_failed', message: error.message } }, 500)
    }
  })

  /**
   * POST /heartbeats/scheduler/pause - Pause the in-process scheduler tick loop.
   * Effect is local to this API instance only (see file header note).
   */
  router.post('/heartbeats/scheduler/pause', async (c) => {
    try {
      const { getActiveHeartbeatScheduler } = await import('../lib/admin-heartbeat')
      const scheduler = await getActiveHeartbeatScheduler()
      scheduler.pause()
      return c.json({ ok: true, data: { paused: scheduler.isPaused() } })
    } catch (error: any) {
      console.error('[Admin] Heartbeats pause error:', error)
      return c.json({ error: { code: 'heartbeats_failed', message: error.message } }, 500)
    }
  })

  /**
   * POST /heartbeats/scheduler/resume - Resume the in-process scheduler.
   */
  router.post('/heartbeats/scheduler/resume', async (c) => {
    try {
      const { getActiveHeartbeatScheduler } = await import('../lib/admin-heartbeat')
      const scheduler = await getActiveHeartbeatScheduler()
      scheduler.resume()
      return c.json({ ok: true, data: { paused: scheduler.isPaused() } })
    } catch (error: any) {
      console.error('[Admin] Heartbeats resume error:', error)
      return c.json({ error: { code: 'heartbeats_failed', message: error.message } }, 500)
    }
  })

  /**
   * POST /heartbeats/projects/:projectId/trigger - Force-fire a heartbeat now.
   */
  router.post('/heartbeats/projects/:projectId/trigger', async (c) => {
    const projectId = c.req.param('projectId')
    try {
      const config = await prisma.agentConfig.findUnique({ where: { projectId } })
      if (!config) {
        return c.json({ error: { code: 'not_found', message: 'Agent config not found' } }, 404)
      }
      const { getActiveHeartbeatScheduler } = await import('../lib/admin-heartbeat')
      const scheduler = await getActiveHeartbeatScheduler()
      const result = await scheduler.triggerNow(projectId)
      return c.json({ ok: true, data: result })
    } catch (error: any) {
      console.error('[Admin] Heartbeats trigger error:', error)
      return c.json({ error: { code: 'heartbeats_failed', message: error.message } }, 500)
    }
  })

  /**
   * PATCH /heartbeats/projects/:projectId - Admin override for AgentConfig
   * heartbeat fields. Bypasses the paid-plan gate enforced on the user-facing
   * route; recomputes nextHeartbeatAt with jitter when enabling or when the
   * interval changes.
   */
  router.patch('/heartbeats/projects/:projectId', async (c) => {
    const projectId = c.req.param('projectId')
    try {
      const body = await c.req.json()
      const data: Record<string, any> = {}

      if (typeof body.heartbeatEnabled === 'boolean') {
        data.heartbeatEnabled = body.heartbeatEnabled
      }
      if (typeof body.heartbeatInterval === 'number') {
        if (body.heartbeatInterval < 60) {
          return c.json(
            { error: { code: 'invalid_interval', message: 'heartbeatInterval must be >= 60 seconds' } },
            400
          )
        }
        data.heartbeatInterval = body.heartbeatInterval
      }
      if (body.quietHoursStart !== undefined) data.quietHoursStart = body.quietHoursStart || null
      if (body.quietHoursEnd !== undefined) data.quietHoursEnd = body.quietHoursEnd || null
      if (body.quietHoursTimezone !== undefined) {
        data.quietHoursTimezone = body.quietHoursTimezone || null
      }

      const existing = await prisma.agentConfig.findUnique({ where: { projectId } })
      if (!existing) {
        return c.json({ error: { code: 'not_found', message: 'Agent config not found' } }, 404)
      }

      const enabled = data.heartbeatEnabled ?? existing.heartbeatEnabled
      const interval = data.heartbeatInterval ?? existing.heartbeatInterval
      const intervalChanged =
        typeof data.heartbeatInterval === 'number' && data.heartbeatInterval !== existing.heartbeatInterval
      const enabledFlipped =
        typeof data.heartbeatEnabled === 'boolean' && data.heartbeatEnabled !== existing.heartbeatEnabled

      if (!enabled) {
        data.nextHeartbeatAt = null
      } else if (enabledFlipped || intervalChanged) {
        const { computeJitter } = await import('../lib/base-heartbeat-scheduler')
        const jitter = computeJitter(interval)
        data.nextHeartbeatAt = new Date(Date.now() + interval * 1000 + jitter)
      }

      const updated = await prisma.agentConfig.update({
        where: { projectId },
        data,
        select: {
          id: true,
          projectId: true,
          heartbeatEnabled: true,
          heartbeatInterval: true,
          nextHeartbeatAt: true,
          lastHeartbeatAt: true,
          quietHoursStart: true,
          quietHoursEnd: true,
          quietHoursTimezone: true,
          modelProvider: true,
          modelName: true,
        },
      })

      return c.json({
        ok: true,
        data: {
          ...updated,
          modelLabel: updated.modelName ? await resolveModelLabel(updated.modelName) : null,
        },
      })
    } catch (error: any) {
      console.error('[Admin] Heartbeats patch error:', error)
      return c.json({ error: { code: 'heartbeats_failed', message: error.message } }, 500)
    }
  })

  /**
   * POST /heartbeats/projects/:projectId/clear-failures - Reset the in-memory
   * circuit breaker entry for one project so it leaves backoff on the next tick.
   */
  router.post('/heartbeats/projects/:projectId/clear-failures', async (c) => {
    const projectId = c.req.param('projectId')
    try {
      const { getActiveHeartbeatScheduler } = await import('../lib/admin-heartbeat')
      const scheduler = await getActiveHeartbeatScheduler()
      scheduler.clearFailures(projectId)
      return c.json({ ok: true })
    } catch (error: any) {
      console.error('[Admin] Heartbeats clear-failures error:', error)
      return c.json({ error: { code: 'heartbeats_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Affiliate management
  // --------------------------------------------------------------------------

  /**
   * PATCH /affiliates/:id - Set or clear an affiliate's per-affiliate
   * commission-rate override. `commissionRateBps` is in basis points
   * (2000 = 20.00%), range 0..10000 (0%..100%). Pass `null` to clear the
   * override and fall back to the per-level `AffiliateCommissionTier` rate.
   *
   * The override only affects the affiliate's direct (L1) referral
   * commissions, applied as a flat rate (the tier's durationDays window and
   * secondaryRateBps step-down are bypassed). See
   * apps/api/src/services/affiliate.service.ts:recordCommissionsForInvoice.
   */
  router.patch('/affiliates/:id', async (c) => {
    const id = c.req.param('id')
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
    }

    // Both overrides are optional; only the fields present in the body are
    // touched. `commissionRateBps` is the referral-commission override (bps,
    // 0..10000); `contentCpmCents` is the per-creator content-CPM override
    // (cents per 1,000 views, >= 0). Pass null on either to clear it and fall
    // back to the platform default.
    const data: { commissionRateBps?: number | null; contentCpmCents?: number | null } = {}

    if ('commissionRateBps' in body) {
      const raw = body.commissionRateBps
      if (raw === null) {
        data.commissionRateBps = null
      } else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 10000) {
        data.commissionRateBps = raw
      } else {
        return c.json(
          {
            error: {
              code: 'invalid_rate',
              message: 'commissionRateBps must be null or an integer between 0 and 10000 (basis points)',
            },
          },
          400,
        )
      }
    }

    if ('contentCpmCents' in body) {
      const raw = body.contentCpmCents
      if (raw === null) {
        data.contentCpmCents = null
      } else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
        data.contentCpmCents = raw
      } else {
        return c.json(
          {
            error: {
              code: 'invalid_cpm',
              message: 'contentCpmCents must be null or a non-negative integer (cents per 1,000 views)',
            },
          },
          400,
        )
      }
    }

    if (Object.keys(data).length === 0) {
      return c.json(
        {
          error: {
            code: 'bad_request',
            message: 'Provide commissionRateBps and/or contentCpmCents (number or null).',
          },
        },
        400,
      )
    }

    try {
      const existing = await prisma.affiliate.findUnique({ where: { id }, select: { id: true } })
      if (!existing) {
        return c.json({ error: { code: 'affiliate_not_found', message: 'Affiliate not found' } }, 404)
      }
      const updated = await prisma.affiliate.update({
        where: { id },
        data,
        select: {
          id: true,
          userId: true,
          code: true,
          status: true,
          commissionRateBps: true,
          contentCpmCents: true,
        },
      })
      return c.json({ ok: true, affiliate: updated })
    } catch (error: any) {
      console.error('[Admin] Affiliate rate patch error:', error)
      return c.json({ error: { code: 'affiliate_update_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Creator Stats (creators:read scope)
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Admin access assignment (super_admin only — see gate above)
  // --------------------------------------------------------------------------

  /**
   * GET /admin-scopes - The catalog of assignable admin scopes (for building
   * the assignment UI).
   */
  router.get('/admin-scopes', async (c) => {
    return c.json({ ok: true, data: ADMIN_SCOPES })
  })

  /**
   * PATCH /users/:id/admin-access - Set a user's granular admin scopes.
   * Body: { scopes: string[] }. Scopes are validated against the catalog;
   * an empty array revokes all partial admin access. A user's platform
   * `role` (user vs super_admin) is managed separately.
   */
  router.patch('/users/:id/admin-access', async (c) => {
    const id = c.req.param('id')
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
    }

    const raw = body?.scopes
    if (!Array.isArray(raw)) {
      return c.json(
        { error: { code: 'invalid_scopes', message: 'scopes must be an array of scope ids' } },
        400,
      )
    }
    const invalid = raw.filter((s: unknown) => !isAdminScope(s))
    if (invalid.length > 0) {
      return c.json(
        {
          error: {
            code: 'invalid_scopes',
            message: `Unknown scope(s): ${invalid.join(', ')}`,
          },
        },
        400,
      )
    }
    const scopes = [...new Set(raw as AdminScope[])]

    try {
      const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } })
      if (!existing) {
        return c.json({ error: { code: 'user_not_found', message: 'User not found' } }, 404)
      }
      const updated = await prisma.user.update({
        where: { id },
        data: { adminScopes: scopes },
        select: { id: true, role: true, adminScopes: true },
      })
      return c.json({
        ok: true,
        data: {
          id: updated.id,
          role: updated.role,
          adminScopes: normalizeAdminScopes(updated.adminScopes),
        },
      })
    } catch (error: any) {
      console.error('[Admin] Set admin access error:', error)
      return c.json({ error: { code: 'admin_access_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /creators - Marketplace creators with denormalized marketplace metrics
   * joined to their lifetime platform usage spend.
   */
  router.get('/creators', async (c) => {
    try {
      const data = await analytics.getCreatorStats()
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Creator stats error:', error)
      return c.json({ error: { code: 'creators_failed', message: error.message } }, 500)
    }
  })

  /**
   * GET /creators/:userId - Full per-creator profile: marketplace stats,
   * published listings, lifetime platform spend, and (when enrolled) the
   * affiliate/commission 360. Keyed by the creator's userId. 404 when the
   * user has no CreatorProfile.
   */
  router.get('/creators/:userId', async (c) => {
    try {
      const userId = c.req.param('userId')
      const data = await analytics.getCreatorProfileDetail(userId)
      if (!data) {
        return c.json({ error: { code: 'not_found', message: 'Creator not found' } }, 404)
      }
      return c.json({ ok: true, data })
    } catch (error: any) {
      console.error('[Admin] Creator profile error:', error)
      return c.json({ error: { code: 'creator_profile_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Affiliate content-CPM settings (super-admin; gated by /affiliate-content/*)
  //
  // The whole content-CPM feature (Instagram / TikTok view tracking) is
  // optional and DB-controlled here rather than via env vars. `enabled` is the
  // master toggle; the rest are the polling/payout knobs. The EnsembleData API
  // token is a secret, stored encrypted and surfaced only as a configured/mask
  // flag.
  // --------------------------------------------------------------------------

  /** GET /affiliate-content/settings — current settings + token status. */
  router.get('/affiliate-content/settings', async (c) => {
    const [settings, token] = await Promise.all([
      getContentSettings({ force: true }),
      getEnsembleDataTokenInfo(),
    ])
    return c.json({ ok: true, settings, ensembleDataToken: token })
  })

  /**
   * PUT /affiliate-content/settings — update any subset of the settings.
   * Numeric fields accept null to clear (revert to default). `ensembleDataToken`
   * (when present) is stored encrypted; pass '' or null to clear it.
   */
  router.put('/affiliate-content/settings', async (c) => {
    const auth = c.get('auth')
    const userId = auth?.userId || 'unknown'
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
    }

    if (body?.provider !== undefined && body.provider !== 'ensembledata' && body.provider !== 'official') {
      return c.json(
        { error: { code: 'invalid_provider', message: "provider must be 'ensembledata' or 'official'" } },
        400,
      )
    }
    if (body?.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return c.json({ error: { code: 'invalid_enabled', message: 'enabled must be a boolean' } }, 400)
    }

    const patch: ContentSettingsPatch = {}
    if (body?.enabled !== undefined) patch.enabled = body.enabled
    if (body?.provider !== undefined) patch.provider = body.provider
    for (const field of [
      'cpmCents',
      'cpmCentsInstagram',
      'cpmCentsTiktok',
      'holdDays',
      'postsPerAccount',
      'maxViewsPerPostPerRun',
    ] as const) {
      if (body?.[field] !== undefined) patch[field] = body[field]
    }

    try {
      const settings = await setContentSettings(patch, userId)
      if (body?.ensembleDataToken !== undefined) {
        await setEnsembleDataToken(
          typeof body.ensembleDataToken === 'string' ? body.ensembleDataToken : null,
          userId,
        )
      }
      const token = await getEnsembleDataTokenInfo()
      return c.json({ ok: true, settings, ensembleDataToken: token })
    } catch (error: any) {
      console.error('[Admin] Affiliate content settings update error:', error)
      return c.json({ error: { code: 'settings_update_failed', message: error.message } }, 400)
    }
  })

  // --------------------------------------------------------------------------
  // Creator Stats (creators:read scope)
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Admin access assignment (super_admin only — see gate above)
  // --------------------------------------------------------------------------

  /**
   * GET /admin-scopes - The catalog of assignable admin scopes (for building
   * the assignment UI).
   */
  router.get('/admin-scopes', async (c) => {
    return c.json({ ok: true, data: ADMIN_SCOPES })
  })

  /**
   * PATCH /users/:id/admin-access - Set a user's granular admin scopes.
   * Body: { scopes: string[] }. Scopes are validated against the catalog;
   * an empty array revokes all partial admin access. A user's platform
   * `role` (user vs super_admin) is managed separately.
   */
  router.patch('/users/:id/admin-access', async (c) => {
    const id = c.req.param('id')
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
    }

    const raw = body?.scopes
    if (!Array.isArray(raw)) {
      return c.json(
        { error: { code: 'invalid_scopes', message: 'scopes must be an array of scope ids' } },
        400,
      )
    }
    const invalid = raw.filter((s: unknown) => !isAdminScope(s))
    if (invalid.length > 0) {
      return c.json(
        {
          error: {
            code: 'invalid_scopes',
            message: `Unknown scope(s): ${invalid.join(', ')}`,
          },
        },
        400,
      )
    }
    const scopes = [...new Set(raw as AdminScope[])]

    try {
      const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } })
      if (!existing) {
        return c.json({ error: { code: 'user_not_found', message: 'User not found' } }, 404)
      }
      const updated = await prisma.user.update({
        where: { id },
        data: { adminScopes: scopes },
        select: { id: true, role: true, adminScopes: true },
      })
      return c.json({
        ok: true,
        data: {
          id: updated.id,
          role: updated.role,
          adminScopes: normalizeAdminScopes(updated.adminScopes),
        },
      })
    } catch (error: any) {
      console.error('[Admin] Set admin access error:', error)
      return c.json({ error: { code: 'admin_access_failed', message: error.message } }, 500)
    }
  })

  return router
}

// ============================================================================
// User Attribution Route (separate from admin — authenticated users only)
// ============================================================================

export function userAttributionRoute(): Hono {
  const router = new Hono()
  // IMPORTANT: scope to /users/me/* — not '*'. Hono mounts this router at
  // /api in server.ts via app.route('/api', userAttributionRoute()), and a
  // '*' middleware on a sub-router becomes part of the parent's middleware
  // chain for every /api/* path. That poisoned unrelated routers mounted
  // at the same prefix (e.g. /api/affiliates/lookup was rejected with 401
  // even though its publicPrefixes bypass returned next()). See
  // /tmp/test-attribution-pollution.ts for the minimal repro.
  router.use('/users/me/*', authMiddleware)
  router.use('/users/me/*', requireAuth)

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
