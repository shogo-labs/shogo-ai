// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Scoped Analytics Routes
 *
 * Workspace-level and project-level analytics endpoints that reuse
 * the same analytics service as the admin routes. Every workspace-wide read
 * needs `workspace.analytics:read` (owner/admin); a member's own numbers live
 * on `/me/analytics/*`. None of these need super admin.
 *
 * Mounted at /api/*
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { authMiddleware, requireAuth } from '../middleware/auth'
import { authorize } from '../lib/authz'
import { ANALYTICS_ADMIN_ONLY, canReadWorkspaceAnalytics } from '../lib/analytics-access'
import { isBusinessOrHigherPlan } from '../services/billing.service'
import * as analytics from '../services/analytics.service'
import type { AnalyticsPeriod } from '../services/analytics.service'
import * as engagement from '../services/engagement-analytics.service'
import type { EngagementPeriod } from '../services/engagement-analytics.service'
import { getChannelBreakdown } from '../services/conversation-metrics'

// ============================================================================
// Helpers
// ============================================================================

/** Group-by values the spend chart understands; anything else falls back to model. */
const SPEND_GROUP_BYS = ['model', 'workspace', 'user', 'source', 'category'] as const
type SpendGroupBy = (typeof SPEND_GROUP_BYS)[number]

function parseSpendGroupBy(value: string | null): SpendGroupBy {
  return value && (SPEND_GROUP_BYS as readonly string[]).includes(value)
    ? (value as SpendGroupBy)
    : 'model'
}

/**
 * Workspace analytics reads are owner/admin only. Runs before
 * `requireBusinessPlan` so a member on a Business plan gets
 * `analytics_admin_only`, not the plan message.
 */
const requireAnalyticsAdmin = async (c: any, next: any) => {
  if (!await canReadWorkspaceAnalytics(c, c.req.param('workspaceId'))) {
    return c.json(ANALYTICS_ADMIN_ONLY, 403)
  }
  await next()
}

/** Resolves the project's workspace when the caller can read the project. */
async function checkProjectAccess(c: Context, projectId: string): Promise<string | null> {
  const decision = await authorize(c, 'project:read', { projectId })
  return decision.ok ? decision.access.workspaceId : null
}

const ENGAGEMENT_PERIODS = new Set(['1d', '7d', '30d', '90d', '1y', 'mtd', 'last_month', 'all'])

/** Reads `?period=` for the engagement endpoints, falling back to 30d on anything unknown. */
function parseEngagementPeriod(url: URL): EngagementPeriod {
  const raw = url.searchParams.get('period') || '30d'
  return (ENGAGEMENT_PERIODS.has(raw) ? raw : '30d') as EngagementPeriod
}

// ============================================================================
// Routes
// ============================================================================

export function scopedAnalyticsRoutes(): Hono {
  const router = new Hono()

  // All scoped analytics routes require auth. Scoped per path family, not
  // '*': this router is mounted at /api in server.ts, where a '*' middleware
  // becomes part of the parent's chain for every /api/* route registered
  // after it (SHO-452).
  for (const prefix of ['/workspaces/:workspaceId/analytics/*', '/projects/:projectId/analytics/*', '/me/analytics/*']) {
    router.use(prefix, authMiddleware)
    router.use(prefix, requireAuth)
  }

  // --------------------------------------------------------------------------
  // Workspace Analytics — Basic (workspace owners and admins)
  // --------------------------------------------------------------------------

  router.get('/workspaces/:workspaceId/analytics/overview', requireAnalyticsAdmin, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const data = await analytics.getOverviewStats({ workspaceId })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/member-usage', requireAnalyticsAdmin, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const period = (new URL(c.req.url).searchParams.get('period') || undefined) as AnalyticsPeriod | undefined
      const data = await analytics.getMemberUsageStats(workspaceId, {
        ...(period ? { period } : {}),
      })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/usage-log', requireAnalyticsAdmin, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const page = parseInt(url.searchParams.get('page') || '1', 10)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const userId = url.searchParams.get('userId') || undefined
      const model = url.searchParams.get('model') || undefined

      const data = await analytics.getUsageLog({ workspaceId }, period, { page, limit, userId, model })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/usage-summary', requireAnalyticsAdmin, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const page = parseInt(url.searchParams.get('page') || '1', 10)
      // Default high so the workspace usage table + leaderboard keep showing all
      // rows (workspaces are small); admin paginates explicitly.
      const limit = parseInt(url.searchParams.get('limit') || '500', 10)
      const userId = url.searchParams.get('userId') || undefined
      const data = await analytics.getUsageSummary({ workspaceId, userId }, period, { page, limit })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/spend-timeseries', requireAnalyticsAdmin, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const fromIso = url.searchParams.get('from') || undefined
      const toIso = url.searchParams.get('to') || undefined
      const groupBy = parseSpendGroupBy(url.searchParams.get('groupBy'))
      const metric = (url.searchParams.get('metric') || 'spend') as 'spend' | 'tokens' | 'requests'
      const topN = parseInt(url.searchParams.get('topN') || '8', 10)

      const data = await analytics.getSpendTimeseries(
        { workspaceId },
        period,
        { fromIso, toIso, groupBy, metric, topN },
      )
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/usage-log.csv', requireAnalyticsAdmin, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const userId = url.searchParams.get('userId') || undefined
      const model = url.searchParams.get('model') || undefined
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '5000', 10), 10000)

      const { entries } = await analytics.getUsageLog(
        { workspaceId },
        period,
        { page: 1, limit, userId, model },
      )

      const escape = (val: unknown): string => {
        if (val === null || val === undefined) return ''
        const s = String(val)
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }
      const header = ['Date', 'User', 'Email', 'Type', 'Model', 'Provider', 'Tokens', 'Billed USD', 'Model USD', 'Shogo fee USD']
      const lines: string[] = [header.join(',')]
      for (const e of entries) {
        lines.push(
          [
            escape(e.createdAt),
            escape(e.userName || ''),
            escape(e.userEmail || ''),
            escape(e.actionType || ''),
            escape(e.model || ''),
            escape(e.provider || ''),
            escape(e.totalTokens),
            escape(e.billedUsd.toFixed(4)),
            escape(Number(e.modelCostUsd ?? 0).toFixed(4)),
            escape(Number(e.shogoFeeUsd ?? 0).toFixed(4)),
          ].join(','),
        )
      }
      const csv = lines.join('\n')
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="usage-${workspaceId}-${period}.csv"`,
        },
      })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/member-insights', requireAnalyticsAdmin, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const userId = url.searchParams.get('userId') || undefined

      const data = await analytics.getMemberInsights(workspaceId, period, { userId })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // Z Code-style dashboard (streaks, heatmap, peak hour, model share) plus work
  // activity. Owners/admins may pick any member, or omit `userId` for the whole
  // workspace. Available on every plan.
  router.get('/workspaces/:workspaceId/analytics/engagement', requireAnalyticsAdmin, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const url = new URL(c.req.url)
      const userId = url.searchParams.get('userId') || undefined

      const data = await engagement.getEngagementStats(
        { workspaceId, userId },
        parseEngagementPeriod(url),
        url.searchParams.get('tz'),
      )
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Workspace Analytics — Advanced (Business plan or higher required)
  // --------------------------------------------------------------------------

  const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

  const requireBusinessPlan = async (c: any, next: any) => {
    if (isLocalMode) return next()
    const workspaceId = c.req.param('workspaceId')
    if (!await isBusinessOrHigherPlan(workspaceId)) {
      return c.json({
        error: {
          code: 'plan_required',
          message: 'Advanced workspace analytics require a Business plan or higher.',
        },
      }, 403)
    }
    await next()
  }

  router.get('/workspaces/:workspaceId/analytics/dashboard', requireAnalyticsAdmin, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const fromIso = url.searchParams.get('from') || undefined
      const toIso = url.searchParams.get('to') || undefined
      const groupBy = parseSpendGroupBy(url.searchParams.get('groupBy'))
      const metric = (url.searchParams.get('metric') || 'spend') as 'spend' | 'tokens' | 'requests'
      const topN = parseInt(url.searchParams.get('topN') || '8', 10)
      const page = parseInt(url.searchParams.get('page') || '1', 10)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      // Admins may narrow the dashboard to one member.
      const userId = url.searchParams.get('userId') || undefined

      // The whole Usage tab from one grouped scan; `chat` rides along so the
      // screen needs two requests, not five (SHO-140). Both the chat stats and
      // the usage breakdown are Business-only elsewhere (`/analytics/chat`,
      // `/analytics/usage`), so they stay Business-only here — otherwise this
      // endpoint is a way around the plan gate.
      const business = isLocalMode || await isBusinessOrHigherPlan(workspaceId)
      // The dashboard's grouped scan is scoped to one workspace already, so
      // `workspace` is not a series it can draw — it falls back to model.
      const dashboardGroupBy = groupBy === 'workspace' ? 'model' : groupBy
      const [dashboard, chat] = await Promise.all([
        analytics.getUsageDashboard(
          { workspaceId, ...(userId ? { userId } : {}) },
          { period, fromIso, toIso, groupBy: dashboardGroupBy, metric, topN, page, limit },
        ),
        business
          ? analytics.getChatAnalytics({ workspaceId }, period)
          : Promise.resolve(null),
      ])
      return c.json({
        ok: true,
        data: { ...dashboard, usage: business ? dashboard.usage : null, chat },
      })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/growth', requireAnalyticsAdmin, requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      const data = await analytics.getGrowthTimeSeries({ workspaceId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/usage', requireAnalyticsAdmin, requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      const data = await analytics.getUsageAnalytics({ workspaceId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/chat', requireAnalyticsAdmin, requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      const data = await analytics.getChatAnalytics({ workspaceId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/projects', requireAnalyticsAdmin, requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const data = await analytics.getProjectAnalytics({ workspaceId })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/billing', requireAnalyticsAdmin, requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const data = await analytics.getBillingAnalytics({ workspaceId })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/activity-timeseries', requireAnalyticsAdmin, requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      const data = await analytics.getActivityTimeseries({ workspaceId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/active-users-timeseries', requireAnalyticsAdmin, requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      const data = await analytics.getActiveUsersTimeseries({ workspaceId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/quality-timeseries', requireAnalyticsAdmin, requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      const data = await analytics.getQualityTimeseries({ workspaceId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/tool-calls', requireAnalyticsAdmin, requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const page = parseInt(url.searchParams.get('page') || '1', 10)
      const limit = parseInt(url.searchParams.get('limit') || '10', 10)

      const data = await analytics.getToolCallAnalytics({ workspaceId }, period, { page, limit })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // One row per member: approvals, tasks done, lines changed, messages, tokens,
  // active days, streak. Owners/admins only, and Business plan or higher.
  router.get('/workspaces/:workspaceId/analytics/team-work', requireAnalyticsAdmin, requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const url = new URL(c.req.url)
      const data = await engagement.getTeamWork(workspaceId, parseEngagementPeriod(url), url.searchParams.get('tz'))
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // One row per channel (DMs excluded) plus workspace totals, for the Analytics
  // Channels tab. Owners/admins only, and Business plan or higher.
  router.get('/workspaces/:workspaceId/analytics/channels', requireAnalyticsAdmin, requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const period = parseEngagementPeriod(new URL(c.req.url))
      const data = await getChannelBreakdown(workspaceId, engagement.engagementWindow(period))
      return c.json({ ok: true, data: { period, ...data } })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // Every agent in the workspace with a heartbeat on (plus any that spent in the
  // window and has since been switched off): schedule, model and what it cost.
  // Owners/admins only, and Business plan or higher.
  router.get('/workspaces/:workspaceId/analytics/heartbeats', requireAnalyticsAdmin, requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')

      const data = await analytics.getWorkspaceHeartbeats(workspaceId, {
        period: analytics.parseHeartbeatPeriod(new URL(c.req.url).searchParams.get('period')),
      })

      // Turning one off is a PATCH on the project's heartbeat; an admin may do
      // it for every project in the workspace.
      const agents = data.agents.map((agent) => ({ ...agent, canEdit: true }))

      return c.json({ ok: true, data: { ...data, agents } })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Project Analytics
  // --------------------------------------------------------------------------

  router.get('/projects/:projectId/analytics/overview', async (c) => {
    try {
      const projectId = c.req.param('projectId')

      const workspaceId = await checkProjectAccess(c, projectId)
      if (!workspaceId) {
        return c.json({ error: { code: 'forbidden', message: 'No access to this project' } }, 403)
      }
      if (!await canReadWorkspaceAnalytics(c, workspaceId)) {
        return c.json(ANALYTICS_ADMIN_ONLY, 403)
      }

      const data = await analytics.getOverviewStats({ workspaceId, projectId })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/projects/:projectId/analytics/chat', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      const workspaceId = await checkProjectAccess(c, projectId)
      if (!workspaceId) {
        return c.json({ error: { code: 'forbidden', message: 'No access to this project' } }, 403)
      }
      if (!await canReadWorkspaceAnalytics(c, workspaceId)) {
        return c.json(ANALYTICS_ADMIN_ONLY, 403)
      }

      const data = await analytics.getChatAnalytics({ workspaceId, projectId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/projects/:projectId/analytics/usage', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      const workspaceId = await checkProjectAccess(c, projectId)
      if (!workspaceId) {
        return c.json({ error: { code: 'forbidden', message: 'No access to this project' } }, 403)
      }
      if (!await canReadWorkspaceAnalytics(c, workspaceId)) {
        return c.json(ANALYTICS_ADMIN_ONLY, 403)
      }

      const data = await analytics.getUsageAnalytics({ workspaceId, projectId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // User (Me) Analytics
  // --------------------------------------------------------------------------

  router.get('/me/analytics/overview', async (c) => {
    try {
      const auth = c.get('auth')
      const data = await analytics.getOverviewStats({ userId: auth.userId! })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/me/analytics/usage-log', async (c) => {
    try {
      const auth = c.get('auth')
      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const page = parseInt(url.searchParams.get('page') || '1', 10)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const model = url.searchParams.get('model') || undefined

      const data = await analytics.getUsageLog({ userId: auth.userId! }, period, { page, limit, model })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/me/analytics/usage-summary', async (c) => {
    try {
      const auth = c.get('auth')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      const data = await analytics.getUsageSummary({ userId: auth.userId! }, period, { limit: 500 })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/me/analytics/engagement', async (c) => {
    try {
      const auth = c.get('auth')
      const url = new URL(c.req.url)
      // Spans every workspace the person belongs to; only ever their own rows.
      const data = await engagement.getEngagementStats(
        { userId: auth.userId! },
        parseEngagementPeriod(url),
        url.searchParams.get('tz'),
      )
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  return router
}
